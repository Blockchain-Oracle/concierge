// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { ConciergeRegistry } from "../src/ConciergeRegistry.sol";
import { ConciergeRegistryProxy } from "../src/ConciergeRegistryProxy.sol";
import { IConciergeRegistry } from "../src/interfaces/IConciergeRegistry.sol";
import {
    NotAgentOwner,
    AgentInactive,
    InvalidValidator,
    InvalidOwner,
    EmptyGoalHash,
    PolicyTooLarge,
    AgentNotFound
} from "../src/errors/ConciergeErrors.sol";

/// @notice Shared setup for all ConciergeRegistry test contracts.
abstract contract ConciergeRegistryBase is Test {
    ConciergeRegistry internal impl;
    ConciergeRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal pauser = makeAddr("pauser");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    address internal validator = makeAddr("validator");
    bytes32 internal goalHash = keccak256("goal-v1");
    bytes internal policyData = abi.encode("policy-v1");

    function setUp() public virtual {
        impl = new ConciergeRegistry();
        bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (admin));
        ConciergeRegistryProxy proxy = new ConciergeRegistryProxy(address(impl), initData);
        registry = ConciergeRegistry(address(proxy));

        bytes32 operatorRole = registry.AGENT_OPERATOR_ROLE();
        bytes32 pauserRole = registry.PAUSER_ROLE();
        vm.startPrank(admin);
        registry.grantRole(operatorRole, operator);
        registry.grantRole(pauserRole, pauser);
        vm.stopPrank();
    }

    function _registerAlice() internal returns (uint256) {
        vm.prank(operator);
        return registry.registerAgent(alice, validator, goalHash, policyData);
    }
}
