// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { ConciergeRegistry } from "../../../src/ConciergeRegistry.sol";

/// @dev Invariant handler for ConciergeRegistry. Exposes bounded, semantically valid
///      actions to Foundry's invariant fuzzer. Tracks ghost state that invariant
///      assertions compare against on-chain storage.
contract ConciergeRegistryHandler is Test {
    ConciergeRegistry public registry;

    address internal operator;
    address internal pauser;
    address internal validator;
    address[] internal actors;

    /// Ghost variables mirror expected on-chain state.
    /// ghost_totalRegistered: number of successful registerAgent calls — never decrements.
    uint256 public ghost_totalRegistered;
    /// ghost_activeCount: current count of active agents — increments on register, toggles on setActive.
    uint256 public ghost_activeCount;
    /// ghost_paused: mirrors registry.paused() after every handler call.
    bool public ghost_paused;
    /// ghost_ownerOf: current owner of each agent ID; zero for IDs never registered.
    mapping(uint256 => address) public ghost_ownerOf;

    constructor(
        ConciergeRegistry _registry,
        address _operator,
        address _pauser,
        address _validator,
        address[] memory _actors
    ) {
        registry = _registry;
        operator = _operator;
        pauser = _pauser;
        validator = _validator;
        actors = _actors;
        // Mirror the registry's initial paused state instead of relying on the bool default.
        ghost_paused = _registry.paused();
    }

    function _pickActor(
        uint256 seed
    ) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ─── Handler functions ──────────────────────────────────────────────────

    function registerAgent_h(
        uint256 actorSeed,
        bytes32 goalHash
    ) external {
        if (goalHash == bytes32(0)) return;
        address owner = _pickActor(actorSeed);

        vm.prank(operator);
        try registry.registerAgent(owner, validator, goalHash, "") returns (uint256 id) {
            ghost_totalRegistered++;
            ghost_activeCount++;
            ghost_ownerOf[id] = owner;
        } catch { }
    }

    function updateGoal_h(
        uint256 idSeed,
        bytes32 newGoal
    ) external {
        if (ghost_totalRegistered == 0) return;
        if (newGoal == bytes32(0)) return;
        if (ghost_paused) return;
        uint256 id = bound(idSeed, 1, ghost_totalRegistered);
        // Agent must be active — skip rather than catch; unexpected reverts surface as failures.
        if (!registry.getAgent(id).active) return;
        address owner = ghost_ownerOf[id];

        vm.prank(owner);
        registry.updateGoal(id, newGoal);
    }

    function updatePolicy_h(
        uint256 idSeed,
        uint256 sizeSeed
    ) external {
        if (ghost_totalRegistered == 0) return;
        if (ghost_paused) return;
        uint256 id = bound(idSeed, 1, ghost_totalRegistered);
        // Agent must be active — skip rather than catch.
        if (!registry.getAgent(id).active) return;
        uint256 size = bound(sizeSeed, 0, registry.MAX_POLICY_SIZE());
        address owner = ghost_ownerOf[id];

        vm.prank(owner);
        registry.updatePolicy(id, new bytes(size));
    }

    function transferAgent_h(
        uint256 idSeed,
        uint256 newOwnerSeed
    ) external {
        if (ghost_totalRegistered == 0) return;
        uint256 id = bound(idSeed, 1, ghost_totalRegistered);
        address newOwner = _pickActor(newOwnerSeed);
        address currentOwner = ghost_ownerOf[id];
        if (newOwner == currentOwner) return;

        vm.prank(currentOwner);
        try registry.transferAgent(id, newOwner) {
            ghost_ownerOf[id] = newOwner;
        } catch { }
    }

    function setActive_h(
        uint256 idSeed,
        bool active
    ) external {
        if (ghost_totalRegistered == 0) return;
        uint256 id = bound(idSeed, 1, ghost_totalRegistered);
        address owner = ghost_ownerOf[id];
        if (registry.getAgent(id).active == active) return;

        vm.prank(owner);
        try registry.setActive(id, active) {
            if (active) ghost_activeCount++;
            else ghost_activeCount--;
        } catch { }
    }

    function updateValidator_h(
        uint256 idSeed,
        address newValidator
    ) external {
        if (ghost_totalRegistered == 0) return;
        if (ghost_paused) return;
        if (newValidator == address(0)) return;
        uint256 id = bound(idSeed, 1, ghost_totalRegistered);
        address owner = ghost_ownerOf[id];

        vm.prank(owner);
        // SameValidator revert is expected — keep try/catch for that case alone.
        try registry.updateValidator(id, newValidator) { } catch { }
    }

    function pause_h() external {
        vm.prank(pauser);
        try registry.pause() {
            ghost_paused = true;
        } catch { }
    }

    function unpause_h() external {
        vm.prank(pauser);
        try registry.unpause() {
            ghost_paused = false;
        } catch { }
    }
}
