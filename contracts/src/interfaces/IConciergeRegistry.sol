// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    NotAgentOwner,
    AgentInactive,
    InvalidValidator,
    InvalidOwner,
    SameOwner,
    EmptyGoalHash,
    PolicyTooLarge,
    AgentNotFound,
    OwnerIndexCorrupted,
    AgentAlreadyInState,
    UnexpectedValue,
    OwnerAgentLimitReached
} from "../errors/ConciergeErrors.sol";

/// @notice On-chain identity + policy store for Concierge agents (ADR-009).
/// The tick loop reads `getAgent(agentId)` each tick; ERC-8004 attestations
/// reference `agentId` via registry metadata (story-83).
interface IConciergeRegistry {
    // ─── Structs ───────────────────────────────────────────────────────────

    /// @dev Field order is chosen for storage packing: `owner` (20 bytes) and
    ///      `active` (1 byte) share one slot, saving 1 SSTORE on registerAgent
    ///      and 1 SLOAD on every updateGoal/updatePolicy/setActive call.
    ///      `active` is only meaningful when `activatedAt > 0` (registered).
    struct AgentRecord {
        address owner; // packed with `active` in the same slot
        bool active; // true = operational; only valid when activatedAt > 0
        address sessionKeyValidator; // immutable after registration; rotate via updateValidator
        bytes32 goalHash; // keccak256(canonicalJSON(goal)) — computed off-chain
        bytes policyData; // abi.encode(Policy), max 4096 bytes, decoded off-chain
        uint256 activatedAt;
    }

    // ─── Events ────────────────────────────────────────────────────────────

    event AgentRegistered(
        uint256 indexed agentId, address indexed owner, address indexed validator, bytes32 goalHash
    );
    event GoalUpdated(uint256 indexed agentId, bytes32 indexed newGoalHash);
    /// @dev policyHash = keccak256(newPolicy) — allows off-chain integrity checks
    ///      without replaying full calldata.
    event PolicyUpdated(uint256 indexed agentId, bytes32 indexed policyHash);
    /// @dev previousActive is included so indexers can derive state without
    ///      replaying all prior ActiveSet events for the same agentId.
    event ActiveSet(uint256 indexed agentId, bool previousActive, bool active);
    event AgentTransferred(uint256 indexed agentId, address indexed from, address indexed to);
    event ValidatorUpdated(
        uint256 indexed agentId, address indexed previousValidator, address indexed newValidator
    );

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
    /// @dev Reverts with AgentAlreadyInState if the flag is already at the
    ///      requested value, preventing spurious events.
    function setActive(
        uint256 agentId,
        bool active
    ) external;

    /// @notice Transfer ownership of an agent. Caller must be the current owner.
    /// @dev Reverts with InvalidOwner if newOwner is address(0).
    ///      Reverts with SameOwner if newOwner equals the current owner.
    ///      Preserves the agent's current `active` flag — the new owner must call
    ///      setActive(true) if the agent was deactivated before transfer.
    function transferAgent(
        uint256 agentId,
        address newOwner
    ) external;

    /// @notice Replace the session-key validator. Caller must be the owner.
    /// @dev Reverts with AgentInactive if the agent is deactivated.
    ///      Reverts with InvalidValidator if newValidator is address(0).
    function updateValidator(
        uint256 agentId,
        address newValidator
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
    /// @dev Includes both active and inactive agents. Callers that need only
    ///      active agents must filter by checking getAgent(id).active.
    function agentsByOwner(
        address owner
    ) external view returns (uint256[] memory);
}
