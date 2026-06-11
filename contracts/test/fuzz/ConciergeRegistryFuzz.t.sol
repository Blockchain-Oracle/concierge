// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { ConciergeRegistry } from "../../src/ConciergeRegistry.sol";
import { ConciergeRegistryProxy } from "../../src/ConciergeRegistryProxy.sol";
import { IConciergeRegistry } from "../../src/interfaces/IConciergeRegistry.sol";
import {
    PolicyTooLarge,
    EmptyGoalHash,
    AgentAlreadyInState,
    OwnerAgentLimitReached,
    InvalidOwner
} from "../../src/errors/ConciergeErrors.sol";

/// forge-config: default.fuzz.runs = 1024

/// @notice Fuzz tests for ConciergeRegistry (story-12).
/// Exercises wide input ranges for goal hashes, policy bytes, agent IDs,
/// and addresses to catch boundary and adversarial-input bugs.
contract ConciergeRegistryFuzzTest is Test {
    ConciergeRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal validator = makeAddr("validator");

    function setUp() public {
        ConciergeRegistry impl = new ConciergeRegistry();
        bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (admin));
        ConciergeRegistryProxy proxy = new ConciergeRegistryProxy(address(impl), initData);
        registry = ConciergeRegistry(address(proxy));

        vm.startPrank(admin);
        registry.grantRole(registry.AGENT_OPERATOR_ROLE(), operator);
        vm.stopPrank();
    }

    // ─── Goal hash dimension ────────────────────────────────────────────────

    /// Any non-zero bytes32 must register successfully and fully initialise the record.
    function testFuzz_RegisterAgent_AcceptsAllNonZeroGoalHashes(
        bytes32 hash
    ) public {
        vm.assume(hash != bytes32(0));
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, hash, "");
        IConciergeRegistry.AgentRecord memory rec = registry.getAgent(id);
        assertEq(rec.goalHash, hash);
        assertEq(rec.owner, alice);
        assertEq(rec.sessionKeyValidator, validator);
        assertTrue(rec.active);
        assertEq(rec.policyData.length, 0);
    }

    /// Zero hash must always revert with EmptyGoalHash, regardless of other inputs.
    function testFuzz_RegisterAgent_ZeroGoalHashAlwaysReverts(
        uint256 rawSize
    ) public {
        bytes memory policy = new bytes(bound(rawSize, 0, 4096));
        vm.prank(operator);
        vm.expectRevert(EmptyGoalHash.selector);
        registry.registerAgent(alice, validator, bytes32(0), policy);
    }

    // ─── Policy size dimension ──────────────────────────────────────────────

    /// Any policy at or under MAX_POLICY_SIZE must be stored unchanged.
    function testFuzz_UpdatePolicy_AcceptsAnySizeUnderCap(
        uint256 rawSize
    ) public {
        uint256 size = bound(rawSize, 1, registry.MAX_POLICY_SIZE());
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        bytes memory policy = new bytes(size);
        vm.prank(alice);
        registry.updatePolicy(id, policy);
        assertEq(registry.getAgent(id).policyData.length, size);
    }

    /// Any policy over MAX_POLICY_SIZE must revert with PolicyTooLarge(size).
    function testFuzz_UpdatePolicy_RevertsOnOversize(
        uint256 rawSize
    ) public {
        uint256 max = registry.MAX_POLICY_SIZE();
        uint256 size = bound(rawSize, max + 1, max * 4);
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PolicyTooLarge.selector, size));
        registry.updatePolicy(id, new bytes(size));
    }

    // ─── ID monotonicity ────────────────────────────────────────────────────

    /// agentId must increment by exactly 1 for every successful registration.
    function testFuzz_RegisterAgent_NextIdMonotonicAcrossCalls(
        uint256 rawCount
    ) public {
        uint256 count = bound(rawCount, 1, 50);
        for (uint256 i = 0; i < count; i++) {
            vm.prank(operator);
            uint256 id = registry.registerAgent(alice, validator, keccak256(abi.encode(i)), "");
            assertEq(id, i + 1);
        }
        assertEq(registry.nextAgentId(), count + 1);
    }

    // ─── Transfer + owner index consistency ────────────────────────────────

    /// After any valid transfer: owner updated, old index cleared, new index contains id.
    function testFuzz_TransferAgent_OwnerMapsAlwaysConsistent(
        address newOwner
    ) public {
        vm.assume(newOwner != address(0));
        vm.assume(newOwner != alice);
        vm.assume(registry.agentsByOwner(newOwner).length < registry.MAX_AGENTS_PER_OWNER());

        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");

        vm.prank(alice);
        registry.transferAgent(id, newOwner);

        assertEq(registry.getAgent(id).owner, newOwner);
        assertEq(registry.agentsByOwner(alice).length, 0);
        assertEq(registry.agentsByOwner(newOwner).length, 1);
        assertEq(registry.agentsByOwner(newOwner)[0], id);
    }

    // ─── setActive idempotency ──────────────────────────────────────────────

    /// setActive to the current state always reverts with AgentAlreadyInState.
    function testFuzz_SetActive_SameStateAlwaysReverts(
        bool active
    ) public {
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");

        if (!active) {
            vm.prank(alice);
            registry.setActive(id, false);
            assertFalse(registry.getAgent(id).active);
        }

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgentAlreadyInState.selector, id, active));
        registry.setActive(id, active);
    }

    /// After setActive(id, v), active flag must equal v.
    function testFuzz_SetActive_FlagReflectsRequestedValue(
        bool first,
        bool second
    ) public {
        vm.assume(first != second); // must differ to avoid AgentAlreadyInState on second call
        vm.prank(operator);
        uint256 id = registry.registerAgent(alice, validator, keccak256("g"), "");

        // Start from known state: registered agents are always active
        if (!first) {
            vm.prank(alice);
            registry.setActive(id, false); // deactivate to reach `first = false`
        }
        // Now agent is in state `first`. Toggle to `second`.
        vm.prank(alice);
        registry.setActive(id, second);
        assertEq(registry.getAgent(id).active, second);
    }

    // ─── Address dimension ──────────────────────────────────────────────────

    /// registerAgent must revert InvalidOwner for address(0), regardless of other inputs.
    function testFuzz_RegisterAgent_ZeroOwnerAlwaysReverts(
        bytes32 hash,
        uint256 rawSize
    ) public {
        vm.assume(hash != bytes32(0));
        bytes memory p = new bytes(bound(rawSize, 0, 4096));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(InvalidOwner.selector, address(0)));
        registry.registerAgent(address(0), validator, hash, p);
    }

    /// Per-owner cap is enforced: the (cap+1)th registration must revert.
    function testFuzz_RegisterAgent_CapEnforced_ExactlyAtLimit(
        uint256 rawExtra
    ) public {
        uint256 cap = registry.MAX_AGENTS_PER_OWNER();
        uint256 extra = bound(rawExtra, 1, 10);

        for (uint256 i = 0; i < cap; i++) {
            vm.prank(operator);
            registry.registerAgent(alice, validator, keccak256(abi.encode(i)), "");
        }

        for (uint256 j = 0; j < extra; j++) {
            vm.prank(operator);
            vm.expectRevert(abi.encodeWithSelector(OwnerAgentLimitReached.selector, alice));
            registry.registerAgent(alice, validator, keccak256(abi.encode(cap + j)), "");
        }
    }
}
