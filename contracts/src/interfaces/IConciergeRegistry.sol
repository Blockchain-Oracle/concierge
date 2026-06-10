// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    NotAgentOwner,
    AgentInactive,
    InvalidValidator,
    InvalidOwner,
    EmptyGoalHash,
    PolicyTooLarge,
    AgentNotFound,
    OwnerIndexCorrupted
} from "../errors/ConciergeErrors.sol";

/// @notice On-chain identity + policy store for Concierge agents (ADR-009).
/// The tick loop reads `getAgent(agentId)` each tick; ERC-8004 attestations
/// reference `agentId` via registry metadata (story-83).
interface IConciergeRegistry {
    // ─── Structs ───────────────────────────────────────────────────────────

    struct AgentRecord {
        address owner;
        address sessionKeyValidator;
        bytes32 goalHash; // keccak256(canonicalJSON(goal)) — computed off-chain
        bytes policyData; // abi.encode(Policy), max 4096 bytes, decoded off-chain
        uint256 activatedAt;
        bool active;
    }

    // ─── Events ────────────────────────────────────────────────────────────

    event AgentRegistered(
        uint256 indexed agentId, address indexed owner, address validator, bytes32 goalHash
    );
    event GoalUpdated(uint256 indexed agentId, bytes32 indexed newGoalHash);
    event PolicyUpdated(uint256 indexed agentId);
    event ActiveSet(uint256 indexed agentId, bool active);
    event AgentTransferred(uint256 indexed agentId, address indexed from, address indexed to);

    // ─── Mutations ─────────────────────────────────────────────────────────

    /// @notice Mint a new agent record. Requires AGENT_OPERATOR_ROLE.
    /// @return agentId  The newly minted ID (starts at 1, increments by 1).
    function registerAgent(
        address owner,
        address validator,
        bytes32 goalHash,
        bytes calldata policyData
    ) external returns (uint256 agentId);

    /// @notice Update the goal hash for an agent. Caller must be the owner.
    function updateGoal(
        uint256 agentId,
        bytes32 newGoalHash
    ) external;

    /// @notice Replace an agent's policy blob. Caller must be the owner.
    /// @dev Reverts with PolicyTooLarge if newPolicy.length > 4096.
    ///      Reverts with AgentInactive if the agent is deactivated — consistent
    ///      with updateGoal. Deactivate → update → reactivate is the intended flow.
    function updatePolicy(
        uint256 agentId,
        bytes calldata newPolicy
    ) external;

    /// @notice Flip the active flag. Caller must be the owner.
    function setActive(
        uint256 agentId,
        bool active
    ) external;

    /// @notice Transfer ownership of an agent. Caller must be the current owner.
    /// @dev Reverts with InvalidOwner if newOwner is address(0) or the current owner.
    function transferAgent(
        uint256 agentId,
        address newOwner
    ) external;

    /// @notice Pause all mutations. Requires PAUSER_ROLE.
    function pause() external;

    /// @notice Unpause. Requires PAUSER_ROLE.
    function unpause() external;

    // ─── Reads ─────────────────────────────────────────────────────────────

    /// @notice Returns the full AgentRecord. Never reverts when paused.
    /// @dev Reverts with AgentNotFound if the ID has never been registered.
    function getAgent(
        uint256 agentId
    ) external view returns (AgentRecord memory);

    /// @notice Returns all agentIds owned by `owner` at the time of the call.
    function agentsByOwner(
        address owner
    ) external view returns (uint256[] memory);
}
