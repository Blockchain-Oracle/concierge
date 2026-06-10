// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Raw topic-0 keccak256 constants for ConciergeRegistry events.
/// @dev NOT used in vm.expectEmit tests — those use typed `emit IConciergeRegistry.XXX(...)`
/// syntax which is compiler-checked and preferred. These constants are reserved for
/// low-level log-inspection use cases (off-chain indexer fuzz assertions, story-13
/// invariant handler). If IConciergeRegistry events change, update these constants.
library Events {
    bytes32 internal constant AGENT_REGISTERED =
        keccak256("AgentRegistered(uint256,address,address,bytes32)");
    bytes32 internal constant GOAL_UPDATED = keccak256("GoalUpdated(uint256,bytes32)");
    bytes32 internal constant POLICY_UPDATED = keccak256("PolicyUpdated(uint256,bytes32)");
    bytes32 internal constant ACTIVE_SET = keccak256("ActiveSet(uint256,bool,bool)");
    bytes32 internal constant AGENT_TRANSFERRED =
        keccak256("AgentTransferred(uint256,address,address)");
    bytes32 internal constant VALIDATOR_UPDATED =
        keccak256("ValidatorUpdated(uint256,address,address)");
}
