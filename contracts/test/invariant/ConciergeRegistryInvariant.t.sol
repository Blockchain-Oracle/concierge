// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { ConciergeRegistry } from "../../src/ConciergeRegistry.sol";
import { ConciergeRegistryProxy } from "../../src/ConciergeRegistryProxy.sol";
import { ConciergeRegistryHandler } from "./handlers/ConciergeRegistryHandler.sol";

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 32
/// forge-config: default.invariant.fail_on_revert = false

/// @notice Invariant tests for ConciergeRegistry (story-13).
/// The handler drives action sequences; ghost variables track expected state;
/// invariants assert ghost == actual after every call sequence.
contract ConciergeRegistryInvariantTest is Test {
    ConciergeRegistry internal registry;
    ConciergeRegistryHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal validator = makeAddr("validator");

    function setUp() public {
        ConciergeRegistry impl = new ConciergeRegistry();
        bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (admin));
        ConciergeRegistryProxy proxy = new ConciergeRegistryProxy(address(impl), initData);
        registry = ConciergeRegistry(address(proxy));

        vm.startPrank(admin);
        registry.grantRole(registry.AGENT_OPERATOR_ROLE(), operator);
        registry.grantRole(registry.PAUSER_ROLE(), pauser);
        vm.stopPrank();

        address[] memory actors = new address[](3);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("charlie");

        handler = new ConciergeRegistryHandler(registry, operator, pauser, validator, actors);
        targetContract(address(handler));
    }

    // ─── Invariants ─────────────────────────────────────────────────────────

    /// nextAgentId tracks exactly one ahead of total successful registrations.
    function invariant_NextAgentIdMonotonicallyIncreasing() public view {
        assertEq(registry.nextAgentId(), handler.ghost_totalRegistered() + 1);
    }

    /// Every minted agent record has a non-zero owner — no orphaned IDs.
    function invariant_NoOrphanedAgents() public view {
        uint256 nextId = registry.nextAgentId();
        for (uint256 i = 1; i < nextId; i++) {
            assertNotEq(registry.getAgent(i).owner, address(0));
        }
    }

    /// Forward (agent → owner) and reverse (owner → [agentIds]) mappings are consistent.
    function invariant_OwnerMappingsConsistent() public view {
        uint256 nextId = registry.nextAgentId();
        for (uint256 id = 1; id < nextId; id++) {
            address owner = registry.getAgent(id).owner;
            uint256[] memory owned = registry.agentsByOwner(owner);
            bool found = false;
            for (uint256 j = 0; j < owned.length; j++) {
                if (owned[j] == id) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "agent id missing from owner index");
        }
    }

    /// On-chain count of active agents always matches the ghost tracker.
    function invariant_ActiveCountMatchesGhost() public view {
        uint256 nextId = registry.nextAgentId();
        uint256 actualActive = 0;
        for (uint256 i = 1; i < nextId; i++) {
            if (registry.getAgent(i).active) actualActive++;
        }
        assertEq(actualActive, handler.ghost_activeCount());
    }

    /// Policy size cap is never violated by any sequence of updatePolicy calls.
    function invariant_PolicyBytesSizeRespected() public view {
        uint256 nextId = registry.nextAgentId();
        for (uint256 i = 1; i < nextId; i++) {
            assertLe(
                registry.getAgent(i).policyData.length,
                registry.MAX_POLICY_SIZE(),
                "policyData exceeds MAX_POLICY_SIZE"
            );
        }
    }

    /// PAUSER_ROLE is always retained — recovery from any paused state is possible.
    function invariant_PauserRoleRetained() public view {
        assertTrue(registry.hasRole(registry.PAUSER_ROLE(), pauser));
    }
}
