// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

import { MockSUSDe } from "../../src/mocks/MockSUSDe.sol";
import { MockUSDC } from "../../src/mocks/MockUSDC.sol";
import { MockUSDY } from "../../src/mocks/MockUSDY.sol";
import { MockMETH } from "../../src/mocks/MockMETH.sol";
import {
    MockFaucetToken,
    FaucetCooldownActive,
    FaucetAmountExceedsCap,
    FaucetZeroAmount
} from "../../src/mocks/base/MockFaucetToken.sol";

contract MockTokenTest is Test {
    MockSUSDe internal susde;
    MockUSDC internal usdc;
    MockUSDY internal usdy;
    MockMETH internal meth;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        susde = new MockSUSDe(admin);
        usdc = new MockUSDC(admin);
        usdy = new MockUSDY(admin);
        meth = new MockMETH(admin);
    }

    // ─── Metadata ────────────────────────────────────────────────────────────

    function test_decimals_AllCorrect() public view {
        assertEq(susde.decimals(), 18, "sUSDe decimals");
        assertEq(usdc.decimals(), 6, "USDC decimals");
        assertEq(usdy.decimals(), 18, "USDY decimals");
        assertEq(meth.decimals(), 18, "mETH decimals");
    }

    function test_symbols_AllCorrect() public view {
        assertEq(susde.symbol(), "sUSDe");
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdy.symbol(), "USDY");
        assertEq(meth.symbol(), "mETH");
    }

    function test_names_AllCorrect() public view {
        assertEq(susde.name(), "Staked USDe");
        assertEq(usdc.name(), "USD Coin");
        assertEq(usdy.name(), "Ondo U.S. Dollar Yield");
        assertEq(meth.name(), "mETH");
    }

    function test_faucetCap_AllCorrect() public view {
        assertEq(susde.faucetCap(), 1000e18, "sUSDe cap");
        assertEq(usdc.faucetCap(), 10_000e6, "USDC cap");
        assertEq(usdy.faucetCap(), 1000e18, "USDY cap");
        assertEq(meth.faucetCap(), 5e18, "mETH cap");
    }

    // ─── Faucet happy path ────────────────────────────────────────────────────

    function test_faucet_Happy_sUSDe() public {
        vm.prank(alice);
        susde.faucet(alice, 500e18);
        assertEq(susde.balanceOf(alice), 500e18, "sUSDe balance");
        assertEq(susde.lastFaucetAt(alice), block.timestamp, "lastFaucetAt set");
    }

    function test_faucet_Happy_USDC() public {
        vm.prank(alice);
        usdc.faucet(alice, 5000e6);
        assertEq(usdc.balanceOf(alice), 5000e6);
    }

    function test_faucet_Happy_USDY() public {
        vm.prank(alice);
        usdy.faucet(alice, 1000e18);
        assertEq(usdy.balanceOf(alice), 1000e18);
    }

    function test_faucet_Happy_mETH() public {
        vm.prank(alice);
        meth.faucet(alice, 5e18);
        assertEq(meth.balanceOf(alice), 5e18);
    }

    function test_faucet_EmitsFaucetClaim() public {
        vm.expectEmit(true, false, false, true);
        emit MockFaucetToken.FaucetClaim(alice, 500e18);
        vm.prank(alice);
        susde.faucet(alice, 500e18);
    }

    function test_faucet_ExactCap_Succeeds() public {
        vm.prank(alice);
        susde.faucet(alice, 1000e18);
        assertEq(susde.balanceOf(alice), 1000e18);
    }

    // ─── Cooldown enforcement ─────────────────────────────────────────────────

    function test_faucet_CooldownEnforced() public {
        vm.prank(alice);
        susde.faucet(alice, 100e18);
        vm.warp(block.timestamp + 5 minutes);
        vm.expectRevert(abi.encodeWithSelector(FaucetCooldownActive.selector, 1 days - 5 minutes));
        vm.prank(alice);
        susde.faucet(alice, 100e18);
    }

    function test_faucet_SameBlock_SecondClaimReverts() public {
        vm.prank(alice);
        susde.faucet(alice, 100e18);
        // same block — remaining = exactly 1 day
        vm.expectRevert(abi.encodeWithSelector(FaucetCooldownActive.selector, 1 days));
        vm.prank(alice);
        susde.faucet(alice, 100e18);
    }

    function test_faucet_ExactBoundary_Succeeds() public {
        vm.prank(alice);
        susde.faucet(alice, 100e18);
        vm.warp(block.timestamp + 1 days); // exactly at boundary: block.timestamp == last + COOLDOWN
        vm.prank(alice);
        susde.faucet(alice, 100e18); // strict < means this succeeds
        assertEq(susde.balanceOf(alice), 200e18);
    }

    function test_faucet_CooldownExpiry_SucceedsAfter24h() public {
        vm.prank(alice);
        susde.faucet(alice, 100e18);
        vm.warp(block.timestamp + 1 days + 1 seconds);
        vm.prank(alice);
        susde.faucet(alice, 200e18);
        assertEq(susde.balanceOf(alice), 300e18);
        assertEq(susde.lastFaucetAt(alice), block.timestamp, "lastFaucetAt refreshed");
    }

    function test_faucet_IndependentCooldowns() public {
        vm.prank(alice);
        susde.faucet(alice, 100e18);
        // bob has independent window — must succeed even though alice is in cooldown
        vm.prank(bob);
        susde.faucet(bob, 100e18);
        assertEq(susde.balanceOf(bob), 100e18);
    }

    // Cooldown keys on msg.sender — a third party directing tokens to alice cannot lock alice out.
    function test_faucet_GrieferCannotLockVictim() public {
        vm.prank(bob); // bob (griefer) directs to alice
        susde.faucet(alice, 100e18);
        // alice's own cooldown is untouched — she can still claim
        vm.prank(alice);
        susde.faucet(alice, 100e18);
        assertEq(susde.balanceOf(alice), 200e18);
    }

    // ─── Faucet cap ───────────────────────────────────────────────────────────

    function test_faucet_AmountExceedsCap_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(FaucetAmountExceedsCap.selector, 1001e18, 1000e18));
        vm.prank(alice);
        susde.faucet(alice, 1001e18);
    }

    function test_faucet_ZeroAmount_Reverts() public {
        vm.expectRevert(FaucetZeroAmount.selector);
        vm.prank(alice);
        susde.faucet(alice, 0);
    }

    // ─── Admin mint ───────────────────────────────────────────────────────────

    function test_mint_AdminSucceeds() public {
        vm.prank(admin);
        susde.mint(alice, 100_000e18);
        assertEq(susde.balanceOf(alice), 100_000e18);
    }

    function test_mint_NonAdminReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, susde.MINTER_ROLE()
            )
        );
        vm.prank(alice);
        susde.mint(alice, 100e18);
    }

    function test_mint_BypassesFaucetCap() public {
        vm.prank(admin);
        susde.mint(alice, 1_000_000e18); // far beyond 1000e18 faucet cap
        assertEq(susde.balanceOf(alice), 1_000_000e18);
    }
}
