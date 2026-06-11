// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { HelperConfig, NetworkConfig, UnsupportedChain } from "../../script/HelperConfig.s.sol";
import { SepoliaSeedPrices } from "../../script/lib/SepoliaSeedPrices.sol";
import {
    AAVE_V3_POOL_MAINNET,
    AAVE_V3_ORACLE_MAINNET,
    SUSDE_MAINNET,
    USDC_MAINNET,
    USDY_MAINNET,
    METH_MAINNET,
    ERC8004_IDENTITY_MAINNET,
    ERC8004_REPUTATION_MAINNET,
    LIFI_DIAMOND,
    ERC8004_IDENTITY_SEPOLIA,
    ERC8004_REPUTATION_SEPOLIA,
    EMODE_STABLECOIN_CATEGORY
} from "../../script/lib/Addresses.sol";
import { MockAaveOracle } from "../../src/mocks/MockAaveOracle.sol";

contract HelperConfigTest is Test {
    HelperConfig internal config;

    function setUp() public {
        config = new HelperConfig();
    }

    // ─── Mainnet (chainId 5000) ───────────────────────────────────────────────

    function test_HelperConfig_Mainnet_ReturnsVerifiedAddresses() public {
        vm.chainId(5000);
        NetworkConfig memory cfg = config.getConfig();
        assertEq(cfg.aavePool, AAVE_V3_POOL_MAINNET, "aavePool");
        assertEq(cfg.aaveOracle, AAVE_V3_ORACLE_MAINNET, "aaveOracle");
        assertEq(cfg.sUSDe, SUSDE_MAINNET, "sUSDe");
        assertEq(cfg.USDC, USDC_MAINNET, "USDC");
        assertEq(cfg.USDY, USDY_MAINNET, "USDY");
        assertEq(cfg.mETH, METH_MAINNET, "mETH");
        assertEq(cfg.erc8004Identity, ERC8004_IDENTITY_MAINNET, "identity");
        assertEq(cfg.erc8004Reputation, ERC8004_REPUTATION_MAINNET, "reputation");
        assertEq(cfg.lifiDiamond, LIFI_DIAMOND, "lifi");
        assertEq(cfg.emodeStablecoinCategory, EMODE_STABLECOIN_CATEGORY, "emode cat");
    }

    function test_HelperConfig_Mainnet_EModeCategoryIs1() public {
        vm.chainId(5000);
        NetworkConfig memory cfg = config.getConfig();
        assertEq(cfg.emodeStablecoinCategory, 1);
    }

    // ─── Sepolia (chainId 5003) ───────────────────────────────────────────────

    function test_HelperConfig_Sepolia_DeploysMocks() public {
        vm.chainId(5003);
        NetworkConfig memory cfg = config.getConfig();
        assertTrue(cfg.aavePool != address(0), "pool deployed");
        assertTrue(cfg.aaveOracle != address(0), "oracle deployed");
        assertTrue(cfg.sUSDe != address(0), "sUSDe deployed");
        assertTrue(cfg.USDC != address(0), "USDC deployed");
        assertTrue(cfg.USDY != address(0), "USDY deployed");
        assertTrue(cfg.mETH != address(0), "mETH deployed");
    }

    function test_HelperConfig_Sepolia_OracleSeeded() public {
        vm.chainId(5003);
        NetworkConfig memory cfg = config.getConfig();
        MockAaveOracle oracle = MockAaveOracle(cfg.aaveOracle);
        assertGt(oracle.getAssetPrice(cfg.sUSDe), 0, "sUSDe price seeded");
        assertGt(oracle.getAssetPrice(cfg.USDC), 0, "USDC price seeded");
        assertGt(oracle.getAssetPrice(cfg.mETH), 0, "mETH price seeded");
    }

    function test_HelperConfig_Sepolia_UsesSepolia8004Addresses() public {
        vm.chainId(5003);
        NetworkConfig memory cfg = config.getConfig();
        assertEq(cfg.erc8004Identity, ERC8004_IDENTITY_SEPOLIA, "sepolia identity");
        assertEq(cfg.erc8004Reputation, ERC8004_REPUTATION_SEPOLIA, "sepolia reputation");
    }

    function test_HelperConfig_Sepolia_Caches_NoDeploy() public {
        vm.chainId(5003);
        NetworkConfig memory first = config.getConfig();
        NetworkConfig memory second = config.getConfig();
        // Same addresses → no redeploy
        assertEq(first.aavePool, second.aavePool, "pool not redeployed");
        assertEq(first.sUSDe, second.sUSDe, "sUSDe not redeployed");
    }

    // ─── Unsupported chain ────────────────────────────────────────────────────

    function test_HelperConfig_UnsupportedChain_Reverts() public {
        vm.chainId(1); // Ethereum Mainnet — not supported
        vm.expectRevert(abi.encodeWithSelector(UnsupportedChain.selector, 1));
        config.getConfig();
    }

    function test_HelperConfig_UnsupportedChain_Reverts_ForArbitrary() public {
        vm.chainId(42_161); // Arbitrum
        vm.expectRevert(abi.encodeWithSelector(UnsupportedChain.selector, 42_161));
        config.getConfig();
    }

    // ─── SepoliaSeedPrices library ────────────────────────────────────────────

    function test_SeedPrices_ReturnsCorrectCount() public pure {
        uint256[] memory prices = SepoliaSeedPrices.getSeedPrices();
        assertEq(prices.length, 6, "6 seed prices");
    }

    function test_SeedPrices_AllNonZero() public pure {
        uint256[] memory prices = SepoliaSeedPrices.getSeedPrices();
        for (uint256 i = 0; i < prices.length; i++) {
            assertGt(prices[i], 0, "price must be > 0");
        }
    }

    function test_SeedPrices_SUSDePriceMatchesSnapshot() public pure {
        uint256[] memory prices = SepoliaSeedPrices.getSeedPrices();
        assertEq(prices[0], 123_214_617, "sUSDe price matches 2026-06-03 snapshot");
    }
}
