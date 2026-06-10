// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ConciergeRegistryBase } from "./ConciergeRegistryBase.t.sol";
import { IConciergeRegistry } from "../src/interfaces/IConciergeRegistry.sol";
import {
    NotAgentOwner,
    AgentInactive,
    InvalidValidator,
    InvalidOwner,
    EmptyGoalHash,
    PolicyTooLarge,
    AgentNotFound
} from "../src/errors/ConciergeErrors.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Core CRUD tests for ConciergeRegistry (registerAgent, updateGoal,
/// updatePolicy, setActive, reads, fuzz). Admin/pause/upgrade: ConciergeRegistryAdmin.t.sol.
contract ConciergeRegistryTest is ConciergeRegistryBase {
    // ─── registerAgent ─────────────────────────────────────────────────────

    function test_registerAgent_mintsFirstIdAsOne() public {
        assertEq(_registerAlice(), 1);
    }

    function test_registerAgent_incremensNextAgentId() public {
        _registerAlice();
        vm.prank(operator);
        uint256 id2 = registry.registerAgent(bob, validator, goalHash, policyData);
        assertEq(id2, 2);
        assertEq(registry.nextAgentId(), 3);
    }

    function test_registerAgent_storesRecord() public {
        uint256 id = _registerAlice();
        IConciergeRegistry.AgentRecord memory rec = registry.getAgent(id);
        assertEq(rec.owner, alice);
        assertEq(rec.sessionKeyValidator, validator);
        assertEq(rec.goalHash, goalHash);
        assertEq(rec.policyData, policyData);
        assertTrue(rec.active);
        assertGt(rec.activatedAt, 0);
    }

    function test_registerAgent_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit IConciergeRegistry.AgentRegistered(1, alice, validator, goalHash);
        vm.prank(operator);
        registry.registerAgent(alice, validator, goalHash, policyData);
    }

    function test_registerAgent_reverts_zeroOwner() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector, address(0)));
        registry.registerAgent(address(0), validator, goalHash, policyData);
    }

    function test_registerAgent_reverts_zeroValidator() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvalidValidator.selector, address(0)));
        registry.registerAgent(alice, address(0), goalHash, policyData);
    }

    function test_registerAgent_reverts_emptyGoalHash() public {
        vm.prank(operator);
        vm.expectRevert(EmptyGoalHash.selector);
        registry.registerAgent(alice, validator, bytes32(0), policyData);
    }

    function test_registerAgent_reverts_policyTooLarge() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, uint256(4097)));
        registry.registerAgent(alice, validator, goalHash, new bytes(4097));
    }

    function test_registerAgent_reverts_noOperatorRole() public {
        bytes32 role = registry.AGENT_OPERATOR_ROLE();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role
            )
        );
        registry.registerAgent(alice, validator, goalHash, policyData);
    }

    function test_registerAgent_acceptsMaxPolicySize() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, goalHash, new bytes(4096));
        assertEq(registry.getAgent(id).policyData.length, 4096);
    }

    // ─── updateGoal ────────────────────────────────────────────────────────

    function test_updateGoal_succeeds_asOwner() public {
        uint256 id = _registerAlice();
        bytes32 newHash = keccak256("goal-v2");
        vm.prank(alice);
        registry.updateGoal(id, newHash);
        assertEq(registry.getAgent(id).goalHash, newHash);
    }

    function test_updateGoal_emitsGoalUpdated() public {
        uint256 id = _registerAlice();
        bytes32 newHash = keccak256("goal-v2");
        vm.expectEmit(true, true, false, false);
        emit IConciergeRegistry.GoalUpdated(id, newHash);
        vm.prank(alice);
        registry.updateGoal(id, newHash);
    }

    function test_updateGoal_reverts_notOwner() public {
        uint256 id = _registerAlice();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotAgentOwner.selector, id, bob));
        registry.updateGoal(id, keccak256("goal-v2"));
    }

    function test_updateGoal_reverts_emptyHash() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(EmptyGoalHash.selector);
        registry.updateGoal(id, bytes32(0));
    }

    function test_updateGoal_reverts_agentInactive() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.setActive(id, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentInactive.selector, id));
        registry.updateGoal(id, keccak256("goal-v2"));
    }

    function test_updateGoal_reverts_agentNotFound() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, uint256(99)));
        registry.updateGoal(99, keccak256("x"));
    }

    // ─── updatePolicy ──────────────────────────────────────────────────────

    function test_updatePolicy_succeeds_asOwner() public {
        uint256 id = _registerAlice();
        bytes memory newPolicy = abi.encode("policy-v2");
        vm.prank(alice);
        registry.updatePolicy(id, newPolicy);
        assertEq(registry.getAgent(id).policyData, newPolicy);
    }

    function test_updatePolicy_emitsPolicyUpdated() public {
        uint256 id = _registerAlice();
        vm.expectEmit(true, false, false, false);
        emit IConciergeRegistry.PolicyUpdated(id);
        vm.prank(alice);
        registry.updatePolicy(id, abi.encode("v2"));
    }

    function test_updatePolicy_reverts_notOwner() public {
        uint256 id = _registerAlice();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotAgentOwner.selector, id, bob));
        registry.updatePolicy(id, abi.encode("v2"));
    }

    function test_updatePolicy_reverts_agentInactive() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.setActive(id, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentInactive.selector, id));
        registry.updatePolicy(id, abi.encode("v2"));
    }

    function test_updatePolicy_reverts_policyTooLarge() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, uint256(4097)));
        registry.updatePolicy(id, new bytes(4097));
    }

    function test_updatePolicy_storageUnchanged_onRevert() public {
        uint256 id = _registerAlice();
        bytes memory original = registry.getAgent(id).policyData;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, uint256(4097)));
        registry.updatePolicy(id, new bytes(4097));
        assertEq(registry.getAgent(id).policyData, original);
    }

    function test_updatePolicy_reverts_agentNotFound() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, uint256(99)));
        registry.updatePolicy(99, abi.encode("v2"));
    }

    // ─── setActive ─────────────────────────────────────────────────────────

    function test_setActive_deactivates() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.setActive(id, false);
        assertFalse(registry.getAgent(id).active);
    }

    function test_setActive_reactivates() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.setActive(id, false);
        vm.prank(alice);
        registry.setActive(id, true);
        assertTrue(registry.getAgent(id).active);
    }

    function test_setActive_emitsActiveSet() public {
        uint256 id = _registerAlice();
        vm.expectEmit(true, false, false, true);
        emit IConciergeRegistry.ActiveSet(id, false);
        vm.prank(alice);
        registry.setActive(id, false);
    }

    function test_setActive_reverts_notOwner() public {
        uint256 id = _registerAlice();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotAgentOwner.selector, id, bob));
        registry.setActive(id, false);
    }

    function test_setActive_reverts_agentNotFound() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, uint256(99)));
        registry.setActive(99, false);
    }

    // getAgent never auto-reverts on inactive read
    function test_getAgent_returnsInactiveRecord() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.setActive(id, false);
        assertFalse(registry.getAgent(id).active);
    }

    function test_getAgent_reverts_agentNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, uint256(99)));
        registry.getAgent(99);
    }

    function test_agentsByOwner_emptyForUnknownOwner() public {
        assertEq(registry.agentsByOwner(makeAddr("nobody")).length, 0);
    }

    // ─── Fuzz ──────────────────────────────────────────────────────────────

    function testFuzz_registerAgent_idAlwaysIncrements(
        uint8 count
    ) public {
        count = uint8(bound(count, 1, 50));
        for (uint256 i = 0; i < count; i++) {
            vm.prank(operator);
            uint256 id =
                registry.registerAgent(alice, validator, keccak256(abi.encode(i)), policyData);
            assertEq(id, i + 1);
        }
        assertEq(registry.nextAgentId(), uint256(count) + 1);
    }

    function testFuzz_updatePolicy_rejectsOversized(
        uint16 rawSize
    ) public {
        uint256 size = bound(rawSize, 4097, 65_535);
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, size));
        registry.updatePolicy(id, new bytes(size));
    }
}
