// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ConciergeRegistry } from "../../src/ConciergeRegistry.sol";

/// @notice Reusable fixture helpers for ConciergeRegistry tests.
library AgentFixtures {
    /// @dev Encodes a canonical policy blob with a spend cap and three feature flags.
    function makePolicy(
        uint256 maxSpend,
        bool flag0,
        bool flag1,
        bool flag2
    ) internal pure returns (bytes memory) {
        return abi.encode(maxSpend, flag0, flag1, flag2);
    }

    /// @dev Deterministic goal hash from a human-readable label.
    function makeGoalHash(
        string memory label
    ) internal pure returns (bytes32) {
        return keccak256(bytes(label));
    }

    /// @dev Registers an agent owned by `owner` via `registry`. Caller must already
    ///      be pranked as an address with AGENT_OPERATOR_ROLE.
    function registerTestAgent(
        ConciergeRegistry registry,
        address owner,
        address validator,
        string memory goalLabel
    ) internal returns (uint256 agentId) {
        bytes memory policy = makePolicy(1 ether, true, false, false);
        bytes32 goal = makeGoalHash(goalLabel);
        agentId = registry.registerAgent(owner, validator, goal, policy);
    }
}
