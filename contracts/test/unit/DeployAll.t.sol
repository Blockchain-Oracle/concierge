// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { DeployAll } from "../../script/DeployAll.s.sol";

/// @notice BDD: DeployAll chain-guard and balance-guard behaviour.
/// These tests cover the two require() guards that fire before any broadcast —
/// the safety rails that prevent a wrong-chain or underfunded deploy.
contract DeployAllGuardTest is Test {
    DeployAll private script;

    function setUp() public {
        script = new DeployAll();
        // Fund tx.origin well above the 0.1 MNT threshold so the balance guard
        // does not interfere with tests that target the chain guard.
        vm.deal(tx.origin, 1 ether);
    }

    // ─── Chain guard ─────────────────────────────────────────────────────────

    function test_DeployAll_RevertsOnEthereumMainnet() public {
        vm.chainId(1);
        vm.expectRevert("DeployAll: unsupported chain");
        script.run();
    }

    function test_DeployAll_RevertsOnArbitrum() public {
        vm.chainId(42_161);
        vm.expectRevert("DeployAll: unsupported chain");
        script.run();
    }

    function test_DeployAll_RevertsOnPolygon() public {
        vm.chainId(137);
        vm.expectRevert("DeployAll: unsupported chain");
        script.run();
    }

    // ─── Balance guard ───────────────────────────────────────────────────────

    function test_DeployAll_RevertsWhenBalanceBelowThreshold_Mainnet() public {
        vm.chainId(5000);
        vm.deal(tx.origin, 0.05 ether); // below 0.1 MNT floor
        vm.expectRevert("DeployAll: deployer balance < 0.1 MNT, top up first");
        script.run();
    }

    function test_DeployAll_RevertsWhenBalanceBelowThreshold_Sepolia() public {
        vm.chainId(5003);
        vm.deal(tx.origin, 0.001 ether); // below 0.1 MNT floor
        vm.expectRevert("DeployAll: deployer balance < 0.1 MNT, top up first");
        script.run();
    }

    function test_DeployAll_RevertsWhenBalanceIsZero() public {
        vm.chainId(5003);
        vm.deal(tx.origin, 0);
        vm.expectRevert("DeployAll: deployer balance < 0.1 MNT, top up first");
        script.run();
    }
}
