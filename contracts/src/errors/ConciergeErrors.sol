// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Typed errors for ConciergeRegistry (ADR-009, OZ v5 convention).
/// Custom errors save ~50% gas vs require strings and give callers typed reverts.

/// @param agentId  The agent the caller tried to mutate.
/// @param caller   msg.sender that attempted the action.
error NotAgentOwner(uint256 agentId, address caller);

/// @param agentId  The agent that is currently inactive.
error AgentInactive(uint256 agentId);

/// @param validator  The zero-or-unsupported address that was rejected.
error InvalidValidator(address validator);

/// @param owner  The zero address rejected as owner or newOwner.
error InvalidOwner(address owner);

/// @param agentId  Agent whose ownership was transferred to itself.
/// @param owner    The address that is already the owner.
error SameOwner(uint256 agentId, address owner);

/// Thrown when goalHash is bytes32(0) — the hash of an empty goal.
error EmptyGoalHash();

/// @param size  Byte length of the submitted policyData (> 4096 limit).
error PolicyTooLarge(uint256 size);

/// @param agentId  Queried ID that has never been registered.
error AgentNotFound(uint256 agentId);

/// Thrown by _removeFromOwnerIndex when the ID is absent from the owner's index —
/// indicates an invariant violation (index diverged from storage).
error OwnerIndexCorrupted(address owner, uint256 agentId);

/// @param agentId  Agent whose active flag is already at the requested state.
/// @param state    The no-op value that was submitted.
error AgentAlreadyInState(uint256 agentId, bool state);

/// @param value  Non-zero ETH value sent to a non-payable operation.
error UnexpectedValue(uint256 value);

/// @param owner  Address that has reached the per-owner agent registration cap.
error OwnerAgentLimitReached(address owner);

/// @param agentId   Agent whose validator was re-submitted unchanged.
/// @param validator The address that is already the validator.
error SameValidator(uint256 agentId, address validator);
