// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { ConciergeRegistry } from "../../src/ConciergeRegistry.sol";
import { ConciergeRegistryProxy } from "../../src/ConciergeRegistryProxy.sol";
import { IConciergeRegistry } from "../../src/interfaces/IConciergeRegistry.sol";
import {
    NotAgentOwner,
    AgentInactive,
    InvalidOwner,
    InvalidValidator,
    EmptyGoalHash,
    PolicyTooLarge,
    AgentNotFound
} from "../../src/errors/ConciergeErrors.sol";
import { AgentFixtures } from "../helpers/AgentFixtures.sol";
import { Events } from "../helpers/Events.sol";

/// @notice Unit tests for ConciergeRegistry — happy paths, revert paths, role-gate,
/// and pause-gate coverage as required by story-11. Uses AgentFixtures + Events helpers.
contract ConciergeRegistryUnitTest is Test {
    using AgentFixtures for ConciergeRegistry;

    ConciergeRegistry internal impl;
    ConciergeRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");
    address internal validator = makeAddr("validator");

    function setUp() public {
        impl = new ConciergeRegistry();
        bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (admin));
        ConciergeRegistryProxy proxy = new ConciergeRegistryProxy(address(impl), initData);
        registry = ConciergeRegistry(address(proxy));

        vm.startPrank(admin);
        registry.grantRole(registry.AGENT_OPERATOR_ROLE(), operator);
        registry.grantRole(registry.PAUSER_ROLE(), pauser);
        vm.stopPrank();
    }

    // ─── registerAgent ─────────────────────────────────────────────────────

    function test_registerAgent_HappyPath_MintsIdOneAndEmits() public {
        bytes32 goal = AgentFixtures.makeGoalHash("earn-yield");
        bytes memory policy = AgentFixtures.makePolicy(1 ether, true, false, false);

        vm.expectEmit(true, true, true, true);
        emit IConciergeRegistry.AgentRegistered(1, alice, validator, goal);

        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, goal, policy);

        assertEq(id, 1);
        IConciergeRegistry.AgentRecord memory rec = registry.getAgent(id);
        assertEq(rec.owner, alice);
        assertEq(rec.sessionKeyValidator, validator);
        assertEq(rec.goalHash, goal);
        assertEq(rec.policyData, policy);
        assertTrue(rec.active);
        assertEq(rec.activatedAt, block.timestamp);
    }

    function test_registerAgent_Reverts_OnEmptyGoalHash() public {
        vm.prank(operator);
        vm.expectRevert(EmptyGoalHash.selector);
        registry.registerAgent(alice, validator, bytes32(0), "");
    }

    function test_registerAgent_Reverts_OnZeroOwner() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector, address(0)));
        registry.registerAgent(address(0), validator, keccak256("g"), "");
    }

    function test_registerAgent_Reverts_OnZeroValidator() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvalidValidator.selector, address(0)));
        registry.registerAgent(alice, address(0), keccak256("g"), "");
    }

    function test_registerAgent_Reverts_OnOversizedPolicy() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, uint256(4097)));
        registry.registerAgent(alice, validator, keccak256("g"), new bytes(4097));
    }

    function test_registerAgent_Reverts_WithoutAgentOperatorRole() public {
        bytes32 role = registry.AGENT_OPERATOR_ROLE();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role
            )
        );
        registry.registerAgent(alice, validator, keccak256("g"), "");
    }

    // ─── updateGoal ────────────────────────────────────────────────────────

    function test_updateGoal_HappyPath_StorageUpdatedAndEmits() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(
            alice,
            validator,
            AgentFixtures.makeGoalHash("v1"),
            AgentFixtures.makePolicy(1 ether, true, false, false)
        );
        bytes32 newHash = AgentFixtures.makeGoalHash("v2");

        vm.expectEmit(true, true, false, false);
        emit IConciergeRegistry.GoalUpdated(id, newHash);

        vm.prank(alice);
        registry.updateGoal(id, newHash);
        assertEq(registry.getAgent(id).goalHash, newHash);
    }

    function test_updateGoal_Reverts_WhenCallerNotOwner() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotAgentOwner.selector, id, bob));
        registry.updateGoal(id, keccak256("new"));
    }

    function test_updateGoal_Reverts_WhenAgentInactive() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        vm.prank(alice);
        registry.setActive(id, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentInactive.selector, id));
        registry.updateGoal(id, keccak256("new"));
    }

    // ─── updatePolicy ──────────────────────────────────────────────────────

    function test_updatePolicy_Reverts_OnOversizedBytes() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        bytes memory original = registry.getAgent(id).policyData;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, uint256(4097)));
        registry.updatePolicy(id, new bytes(4097));

        assertEq(registry.getAgent(id).policyData, original);
    }

    // ─── setActive ─────────────────────────────────────────────────────────

    function test_setActive_HappyPath_TogglesFlag() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        assertTrue(registry.getAgent(id).active);

        vm.prank(alice);
        registry.setActive(id, false);
        assertFalse(registry.getAgent(id).active);

        vm.prank(alice);
        registry.setActive(id, true);
        assertTrue(registry.getAgent(id).active);
    }

    // ─── transferAgent ─────────────────────────────────────────────────────

    function test_transferAgent_HappyPath_OwnerMapsUpdate() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");

        vm.expectEmit(true, true, true, false);
        emit IConciergeRegistry.AgentTransferred(id, alice, charlie);

        vm.prank(alice);
        registry.transferAgent(id, charlie);

        assertEq(registry.getAgent(id).owner, charlie);
        assertEq(registry.agentsByOwner(alice).length, 0);
        assertEq(registry.agentsByOwner(charlie).length, 1);
        assertEq(registry.agentsByOwner(charlie)[0], id);
    }

    // ─── Pause gate ─────────────────────────────────────────────────────────

    function test_pause_AllMutationsRevert() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        vm.prank(pauser);
        registry.pause();

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.registerAgent(alice, validator, keccak256("x"), "");

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.updateGoal(id, keccak256("x"));

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.setActive(id, false);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.transferAgent(id, charlie);
    }

    function test_pause_ReadsStillWork() public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        vm.prank(pauser);
        registry.pause();

        assertEq(registry.getAgent(id).owner, alice);
        assertEq(registry.agentsByOwner(alice).length, 1);
    }

    function test_pause_Reverts_WhenNotPauser() public {
        bytes32 role = registry.PAUSER_ROLE();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role
            )
        );
        registry.pause();
    }
}
