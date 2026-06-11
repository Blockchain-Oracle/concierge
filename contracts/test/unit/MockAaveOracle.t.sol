// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

import {
    MockAaveOracle,
    AssetPriceUnavailable,
    BatchLengthMismatch,
    InvalidPrice
} from "../../src/mocks/MockAaveOracle.sol";

contract MockAaveOracleTest is Test {
    MockAaveOracle internal oracle;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    // Mainnet snapshot prices from research/concierge/03-providers/aave-v3-mantle.md (2026-06-03)
    address internal mockSUSDe = makeAddr("sUSDe");
    address internal mockUSDC = makeAddr("USDC");
    address internal mockUSDY = makeAddr("USDY");
    address internal mockMETH = makeAddr("mETH");

    uint256 internal constant SUSDE_PRICE = 123_214_617; // $1.232 (Mainnet snapshot)
    uint256 internal constant USDC_PRICE = 99_968_000; // $0.99968
    uint256 internal constant USDY_PRICE = 100_000_000; // $1.00
    uint256 internal constant METH_PRICE = 109_297_978; // $1.093 (mETH/ETH 1.0929 × $1 base)

    function setUp() public {
        oracle = new MockAaveOracle(admin);

        vm.startPrank(admin);
        oracle.setAssetPrice(mockSUSDe, SUSDE_PRICE);
        oracle.setAssetPrice(mockUSDC, USDC_PRICE);
        oracle.setAssetPrice(mockUSDY, USDY_PRICE);
        oracle.setAssetPrice(mockMETH, METH_PRICE);
        vm.stopPrank();
    }

    // ─── Base currency ────────────────────────────────────────────────────────

    function test_BaseCurrencyUnit_Is1e8() public view {
        assertEq(oracle.BASE_CURRENCY_UNIT(), 1e8);
    }

    function test_BaseCurrency_IsZeroAddress() public view {
        assertEq(oracle.BASE_CURRENCY(), address(0));
    }

    // ─── Seeded prices ────────────────────────────────────────────────────────

    function test_SeededPrices_MatchMainnetSnapshot() public view {
        assertEq(oracle.getAssetPrice(mockSUSDe), SUSDE_PRICE, "sUSDe price");
        assertEq(oracle.getAssetPrice(mockUSDC), USDC_PRICE, "USDC price");
        assertEq(oracle.getAssetPrice(mockUSDY), USDY_PRICE, "USDY price");
        assertEq(oracle.getAssetPrice(mockMETH), METH_PRICE, "mETH price");
    }

    function test_GetAssetPrice_RevertsForUnsetAsset() public {
        vm.expectRevert(abi.encodeWithSelector(AssetPriceUnavailable.selector, alice));
        oracle.getAssetPrice(alice);
    }

    // ─── Batch reads ──────────────────────────────────────────────────────────

    function test_GetAssetsPrices_ReturnsBatch() public view {
        address[] memory assets = new address[](2);
        assets[0] = mockSUSDe;
        assets[1] = mockUSDC;
        uint256[] memory prices = oracle.getAssetsPrices(assets);
        assertEq(prices[0], SUSDE_PRICE);
        assertEq(prices[1], USDC_PRICE);
    }

    function test_GetAssetsPrices_RevertsIfAnyUnset() public {
        address[] memory assets = new address[](2);
        assets[0] = mockSUSDe;
        assets[1] = alice; // unset
        vm.expectRevert(abi.encodeWithSelector(AssetPriceUnavailable.selector, alice));
        oracle.getAssetsPrices(assets);
    }

    // ─── Admin mutations ──────────────────────────────────────────────────────

    function test_SetAssetPrice_RolesGated() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                oracle.ORACLE_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        oracle.setAssetPrice(mockSUSDe, 95_000_000);
    }

    function test_SetAssetPrice_EmitsPriceUpdated() public {
        vm.expectEmit(true, false, false, true);
        emit MockAaveOracle.PriceUpdated(mockSUSDe, SUSDE_PRICE, 95_000_000);
        vm.prank(admin);
        oracle.setAssetPrice(mockSUSDe, 95_000_000);
        assertEq(oracle.getAssetPrice(mockSUSDe), 95_000_000, "price updated");
    }

    function test_SetAssetPrice_RevertsOnZeroPrice() public {
        vm.expectRevert(InvalidPrice.selector);
        vm.prank(admin);
        oracle.setAssetPrice(mockSUSDe, 0);
    }

    function test_SetAssetPrices_BatchUpdate() public {
        address[] memory assets = new address[](2);
        uint256[] memory prices = new uint256[](2);
        assets[0] = mockSUSDe;
        assets[1] = mockMETH;
        prices[0] = 95_000_000;
        prices[1] = 120_000_000;

        vm.expectEmit(true, false, false, true);
        emit MockAaveOracle.PriceUpdated(mockSUSDe, SUSDE_PRICE, 95_000_000);
        vm.expectEmit(true, false, false, true);
        emit MockAaveOracle.PriceUpdated(mockMETH, METH_PRICE, 120_000_000);
        vm.prank(admin);
        oracle.setAssetPrices(assets, prices);

        assertEq(oracle.getAssetPrice(mockSUSDe), 95_000_000, "sUSDe updated");
        assertEq(oracle.getAssetPrice(mockMETH), 120_000_000, "mETH updated");
    }

    function test_SetAssetPrices_RevertsOnLengthMismatch() public {
        address[] memory assets = new address[](2);
        uint256[] memory prices = new uint256[](1);
        assets[0] = mockSUSDe;
        assets[1] = mockUSDC;
        prices[0] = 100_000_000;

        vm.expectRevert(BatchLengthMismatch.selector);
        vm.prank(admin);
        oracle.setAssetPrices(assets, prices);
    }

    function test_SetAssetPrices_RevertsOnZeroPriceInBatch() public {
        address[] memory assets = new address[](2);
        uint256[] memory prices = new uint256[](2);
        assets[0] = mockSUSDe;
        assets[1] = mockUSDC;
        prices[0] = 0; // poison
        prices[1] = USDC_PRICE;

        vm.expectRevert(InvalidPrice.selector);
        vm.prank(admin);
        oracle.setAssetPrices(assets, prices);
    }

    // ─── No-op stub access control ────────────────────────────────────────────

    function test_SetAssetSources_RolesGated() public {
        address[] memory assets = new address[](0);
        address[] memory sources = new address[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                oracle.ORACLE_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        oracle.setAssetSources(assets, sources);
    }

    function test_SetFallbackOracle_RolesGated() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                oracle.ORACLE_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        oracle.setFallbackOracle(alice);
    }

    // ─── Misc interface surface ───────────────────────────────────────────────

    function test_GetSourceOfAsset_ReturnsSelf() public view {
        assertEq(oracle.getSourceOfAsset(mockSUSDe), address(oracle));
    }

    function test_GetFallbackOracle_ReturnsZero() public view {
        assertEq(oracle.getFallbackOracle(), address(0));
    }

    function test_AddressesProvider_ReturnsZero() public view {
        assertEq(address(oracle.ADDRESSES_PROVIDER()), address(0));
    }
}
