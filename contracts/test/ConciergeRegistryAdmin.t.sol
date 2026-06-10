// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ConciergeRegistryBase } from "./ConciergeRegistryBase.t.sol";
import { ConciergeRegistry } from "../src/ConciergeRegistry.sol";
import { ConciergeRegistryProxy } from "../src/ConciergeRegistryProxy.sol";
import { IConciergeRegistry } from "../src/interfaces/IConciergeRegistry.sol";
import {
    NotAgentOwner,
    InvalidOwner,
    SameOwner,
    AgentNotFound,
    UnexpectedValue,
    OwnerAgentLimitReached
} from "../src/errors/ConciergeErrors.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Tests for initialization, transferAgent, pause/unpause, roles, and
/// UUPS upgrade gate. Core CRUD tests: ConciergeRegistry.t.sol.
contract ConciergeRegistryAdminTest is ConciergeRegistryBase {
    // ─── Initialization ────────────────────────────────────────────────────

    function test_initialize_adminHasAdminRole() public view {
        assertTrue(registry.hasRole(registry.ADMIN_ROLE(), admin));
    }

    function test_initialize_adminHasPauserRole() public view {
        assertTrue(registry.hasRole(registry.PAUSER_ROLE(), admin));
    }

    function test_initialize_nextAgentIdStartsAtOne() public view {
        assertEq(registry.nextAgentId(), 1);
    }

    function test_initialize_notPaused() public view {
        assertFalse(registry.paused());
    }

    function test_initialize_adminDoesNotHaveOperatorRole() public view {
        assertFalse(registry.hasRole(registry.AGENT_OPERATOR_ROLE(), admin));
    }

    function test_implConstructor_disablesInitializers() public {
        // OZ v5 Initializable emits InvalidInitialization() when initializers are disabled
        vm.expectRevert(bytes4(keccak256("InvalidInitialization()")));
        impl.initialize(admin);
    }

    function test_initialize_reverts_zeroAdmin() public {
        ConciergeRegistry freshImpl = new ConciergeRegistry();
        bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (address(0)));
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector, address(0)));
        new ConciergeRegistryProxy(address(freshImpl), initData);
    }

    // ─── transferAgent ─────────────────────────────────────────────────────

    function test_transferAgent_updatesOwner() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.transferAgent(id, charlie);
        assertEq(registry.getAgent(id).owner, charlie);
    }

    function test_transferAgent_updatesOwnerIndex() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.transferAgent(id, charlie);
        assertEq(registry.agentsByOwner(alice).length, 0);
        assertEq(registry.agentsByOwner(charlie).length, 1);
        assertEq(registry.agentsByOwner(charlie)[0], id);
    }

    function test_transferAgent_emitsEvent() public {
        uint256 id = _registerAlice();
        vm.expectEmit(true, true, true, false);
        emit IConciergeRegistry.AgentTransferred(id, alice, charlie);
        vm.prank(alice);
        registry.transferAgent(id, charlie);
    }

    function test_transferAgent_reverts_notOwner() public {
        uint256 id = _registerAlice();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotAgentOwner.selector, id, bob));
        registry.transferAgent(id, charlie);
    }

    function test_transferAgent_reverts_zeroNewOwner() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector, address(0)));
        registry.transferAgent(id, address(0));
    }

    function test_transferAgent_reverts_selfTransfer() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SameOwner.selector, id, alice));
        registry.transferAgent(id, alice);
    }

    function test_transferAgent_reverts_agentNotFound() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, uint256(99)));
        registry.transferAgent(99, charlie);
    }

    function test_transferAgent_reverts_recipientAtCap() public {
        uint256 cap = registry.MAX_AGENTS_PER_OWNER();
        for (uint256 i = 0; i < cap; i++) {
            vm.prank(operator);
            registry.registerAgent(charlie, validator, keccak256(abi.encode(i)), policyData);
        }
        uint256 id = _registerAlice();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnerAgentLimitReached.selector, charlie));
        registry.transferAgent(id, charlie);
    }

    function test_transferAgent_inactiveAgent_succeeds() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.setActive(id, false);
        vm.prank(alice);
        registry.transferAgent(id, charlie);
        assertEq(registry.getAgent(id).owner, charlie);
        assertFalse(registry.getAgent(id).active);
    }

    function test_transferAgent_prevOwner_rejected_after_transfer() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.transferAgent(id, charlie);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NotAgentOwner.selector, id, alice));
        registry.updateGoal(id, keccak256("x"));
    }

    function test_transferAgent_middleElementRemoval() public {
        vm.prank(operator);
        uint256 id1 = registry.registerAgent(alice, validator, keccak256("g1"), policyData);
        vm.prank(operator);
        uint256 id2 = registry.registerAgent(alice, validator, keccak256("g2"), policyData);
        vm.prank(operator);
        uint256 id3 = registry.registerAgent(alice, validator, keccak256("g3"), policyData);

        vm.prank(alice);
        registry.transferAgent(id2, charlie);

        uint256[] memory aliceIds = registry.agentsByOwner(alice);
        assertEq(aliceIds.length, 2);
        assertTrue(aliceIds[0] == id1 || aliceIds[1] == id1, "id1 must remain");
        assertTrue(aliceIds[0] == id3 || aliceIds[1] == id3, "id3 must remain");
        assertEq(registry.agentsByOwner(charlie)[0], id2);
    }

    function test_transferAgent_tailElementRemoval() public {
        vm.prank(operator);
        uint256 id1 = registry.registerAgent(alice, validator, keccak256("g1"), policyData);
        vm.prank(operator);
        uint256 id2 = registry.registerAgent(alice, validator, keccak256("g2"), policyData);
        vm.prank(operator);
        uint256 id3 = registry.registerAgent(alice, validator, keccak256("g3"), policyData);

        vm.prank(alice);
        registry.transferAgent(id3, charlie);

        uint256[] memory aliceIds = registry.agentsByOwner(alice);
        assertEq(aliceIds.length, 2);
        assertTrue(aliceIds[0] == id1 || aliceIds[1] == id1, "id1 must remain");
        assertTrue(aliceIds[0] == id2 || aliceIds[1] == id2, "id2 must remain");
        assertEq(registry.agentsByOwner(charlie)[0], id3);
    }

    function test_transferAgent_multipleTransfers_indexRemainsClean() public {
        uint256 id = _registerAlice();
        vm.prank(alice);
        registry.transferAgent(id, charlie);
        vm.prank(charlie);
        registry.transferAgent(id, bob);

        assertEq(registry.agentsByOwner(alice).length, 0);
        assertEq(registry.agentsByOwner(charlie).length, 0);
        assertEq(registry.agentsByOwner(bob).length, 1);
        assertEq(registry.getAgent(id).owner, bob);
    }

    function test_agentsByOwner_returnsMultiple() public {
        vm.prank(operator);
        uint256 id1 = registry.registerAgent(alice, validator, goalHash, policyData);
        vm.prank(operator);
        uint256 id2 = registry.registerAgent(alice, validator, keccak256("goal-2"), policyData);
        uint256[] memory ids = registry.agentsByOwner(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], id1);
        assertEq(ids[1], id2);
    }

    // ─── Pause / unpause ───────────────────────────────────────────────────

    function test_pause_blocksAllMutations() public {
        uint256 id = _registerAlice();
        vm.prank(pauser);
        registry.pause();

        vm.prank(operator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.registerAgent(alice, validator, goalHash, policyData);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.updateGoal(id, keccak256("x"));

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.updatePolicy(id, abi.encode("v2"));

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.setActive(id, false);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.transferAgent(id, charlie);

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.updateValidator(id, makeAddr("v2"));
    }

    function test_pause_doesNotBlockReads() public {
        uint256 id = _registerAlice();
        vm.prank(pauser);
        registry.pause();
        assertEq(registry.getAgent(id).owner, alice);
        assertEq(registry.agentsByOwner(alice).length, 1);
    }

    function test_unpause_restoresMutations() public {
        uint256 id = _registerAlice();
        vm.prank(pauser);
        registry.pause();
        vm.prank(pauser);
        registry.unpause();
        bytes32 newHash = keccak256("goal-v3");
        vm.prank(alice);
        registry.updateGoal(id, newHash);
        assertEq(registry.getAgent(id).goalHash, newHash);
    }

    function test_pause_reverts_noPauserRole() public {
        bytes32 role = registry.PAUSER_ROLE();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role
            )
        );
        registry.pause();
    }

    function test_unpause_reverts_noPauserRole() public {
        bytes32 role = registry.PAUSER_ROLE();
        vm.prank(pauser);
        registry.pause();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role
            )
        );
        registry.unpause();
    }

    // ─── Role access ───────────────────────────────────────────────────────

    function test_roles_adminCanGrantOperator() public {
        bytes32 role = registry.AGENT_OPERATOR_ROLE();
        vm.prank(admin);
        registry.grantRole(role, charlie);
        assertTrue(registry.hasRole(role, charlie));
    }

    function test_roles_operatorCanRegister() public {
        bytes32 role = registry.AGENT_OPERATOR_ROLE();
        vm.prank(admin);
        registry.grantRole(role, charlie);
        vm.prank(charlie);
        assertEq(registry.registerAgent(alice, validator, goalHash, policyData), 1);
    }

    // ─── UUPS upgrade gate ─────────────────────────────────────────────────

    function test_upgrade_reverts_nonAdmin() public {
        ConciergeRegistry newImpl = new ConciergeRegistry();
        bytes32 adminRole = registry.ADMIN_ROLE();
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bob, adminRole
            )
        );
        registry.upgradeToAndCall(address(newImpl), "");
    }

    function test_upgrade_preservesStateWithNonEmptyRegistry() public {
        uint256 id1 = _registerAlice();
        vm.prank(operator);
        uint256 id2 = registry.registerAgent(bob, validator, keccak256("g2"), policyData);

        ConciergeRegistry newImpl = new ConciergeRegistry();
        vm.prank(admin);
        registry.upgradeToAndCall(address(newImpl), "");

        assertEq(registry.nextAgentId(), 3);
        assertEq(registry.getAgent(id1).owner, alice);
        assertEq(registry.getAgent(id2).owner, bob);
        assertTrue(registry.hasRole(registry.ADMIN_ROLE(), admin));

        // Re-init must be blocked with typed error
        vm.expectRevert(bytes4(keccak256("InvalidInitialization()")));
        registry.initialize(makeAddr("attacker"));

        // Post-upgrade mutations must still work
        vm.prank(alice);
        registry.updateGoal(id1, keccak256("goal-v2-post-upgrade"));
        assertEq(registry.getAgent(id1).goalHash, keccak256("goal-v2-post-upgrade"));
    }

    function test_upgradeToAndCall_reverts_ethValue() public {
        ConciergeRegistry newImpl = new ConciergeRegistry();
        vm.deal(admin, 1 ether);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(UnexpectedValue.selector, uint256(1)));
        registry.upgradeToAndCall{ value: 1 }(address(newImpl), "");
    }
}
