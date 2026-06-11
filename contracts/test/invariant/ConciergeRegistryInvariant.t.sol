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
    address internal alice;
    address internal bob;
    address internal charlie;

    /// Stored dynamically so invariants stay in sync with setUp's actor pool.
    address[] internal _actors;

    function setUp() public {
        ConciergeRegistry impl = new ConciergeRegistry();
        bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (admin));
        ConciergeRegistryProxy proxy = new ConciergeRegistryProxy(address(impl), initData);
        registry = ConciergeRegistry(address(proxy));

        vm.startPrank(admin);
        registry.grantRole(registry.AGENT_OPERATOR_ROLE(), operator);
        registry.grantRole(registry.PAUSER_ROLE(), pauser);
        vm.stopPrank();

        alice = makeAddr("alice");
        bob = makeAddr("bob");
        charlie = makeAddr("charlie");

        _actors.push(alice);
        _actors.push(bob);
        _actors.push(charlie);

        address[] memory actors = new address[](3);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = charlie;

        handler = new ConciergeRegistryHandler(registry, operator, pauser, validator, actors);
        targetContract(address(handler));
    }

    // ─── Invariants ─────────────────────────────────────────────────────────

    /// nextAgentId is exactly one ahead of total successful registrations.
    function invariant_NextAgentIdMonotonicallyIncreasing() public view {
        assertEq(registry.nextAgentId(), handler.ghost_totalRegistered() + 1);
    }

    /// Every minted agent record has a non-zero owner and ghost_ownerOf agrees with on-chain.
    function invariant_NoOrphanedAgents() public view {
        uint256 nextId = registry.nextAgentId();
        for (uint256 i = 1; i < nextId; i++) {
            assertNotEq(registry.getAgent(i).owner, address(0));
            assertEq(handler.ghost_ownerOf(i), registry.getAgent(i).owner, "ghost_ownerOf drift");
        }
    }

    /// Forward and reverse owner mappings are consistent in both directions.
    function invariant_OwnerMappingsConsistent() public view {
        // Forward: every agent's ID appears in its owner's index.
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
        // Reverse: every entry in an actor's index points to an agent owned by that actor.
        // Catches stale entries left by a buggy _removeFromOwnerIndex.
        for (uint256 a = 0; a < _actors.length; a++) {
            uint256[] memory owned = registry.agentsByOwner(_actors[a]);
            for (uint256 k = 0; k < owned.length; k++) {
                assertEq(
                    registry.getAgent(owned[k]).owner, _actors[a], "stale reverse-index entry"
                );
            }
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

    /// goalHash is never zero for any registered agent (updateGoal cannot wipe it).
    function invariant_GoalHashNeverZero() public view {
        uint256 nextId = registry.nextAgentId();
        for (uint256 i = 1; i < nextId; i++) {
            assertNotEq(registry.getAgent(i).goalHash, bytes32(0), "goalHash wiped to zero");
        }
    }

    /// sessionKeyValidator is never zero for any registered agent.
    function invariant_ValidatorNeverZero() public view {
        uint256 nextId = registry.nextAgentId();
        for (uint256 i = 1; i < nextId; i++) {
            assertNotEq(
                registry.getAgent(i).sessionKeyValidator,
                address(0),
                "sessionKeyValidator is zero"
            );
        }
    }

    /// Paused state always matches what the handler drove — ghost mirrors on-chain paused flag.
    function invariant_PausedStateRestored() public view {
        assertEq(registry.paused(), handler.ghost_paused());
    }
}
