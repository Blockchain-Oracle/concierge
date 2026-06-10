// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Event signature constants for ConciergeRegistry vm.expectEmit assertions.
/// Centralises the event ABI so test files don't each need to redeclare them.
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
