// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { HelperConfig, NetworkConfig, UnsupportedChain } from "../../script/HelperConfig.s.sol";
import { SepoliaSeedPrices } from "../../script/lib/SepoliaSeedPrices.sol";
import {
    AAVE_V3_POOL_MAINNET,
    AAVE_V3_ORACLE_MAINNET,
    AAVE_V3_ADDRESSES_PROVIDER_MAINNET,
    AAVE_V3_PROTOCOL_DATA_PROVIDER_MAINNET,
    SUSDE_MAINNET,
    USDC_MAINNET,
    USDE_MAINNET,
    USDY_MAINNET,
    METH_MAINNET,
    WMNT_MAINNET,
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
        assertEq(
            cfg.aaveAddressesProvider, AAVE_V3_ADDRESSES_PROVIDER_MAINNET, "aaveAddressesProvider"
        );
        assertEq(
            cfg.aaveProtocolDataProvider,
            AAVE_V3_PROTOCOL_DATA_PROVIDER_MAINNET,
            "aaveProtocolDataProvider"
        );
        assertEq(cfg.sUSDe, SUSDE_MAINNET, "sUSDe");
        assertEq(cfg.USDC, USDC_MAINNET, "USDC");
        assertEq(cfg.USDe, USDE_MAINNET, "USDe");
        assertEq(cfg.USDY, USDY_MAINNET, "USDY");
        assertEq(cfg.mETH, METH_MAINNET, "mETH");
        assertEq(cfg.WMNT, WMNT_MAINNET, "WMNT");
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
        assertTrue(cfg.USDe != address(0), "USDe deployed");
        assertTrue(cfg.USDY != address(0), "USDY deployed");
        assertTrue(cfg.mETH != address(0), "mETH deployed");
        assertTrue(cfg.WMNT != address(0), "WMNT deployed");
    }

    function test_HelperConfig_Sepolia_ProvidersAreZero() public {
        vm.chainId(5003);
        NetworkConfig memory cfg = config.getConfig();
        assertEq(
            cfg.aaveAddressesProvider, address(0), "Sepolia: no addresses provider (mock stack)"
        );
        assertEq(cfg.aaveProtocolDataProvider, address(0), "Sepolia: no data provider (mock stack)");
    }

    function test_HelperConfig_Sepolia_OracleSeededAllAssets() public {
        vm.chainId(5003);
        NetworkConfig memory cfg = config.getConfig();
        MockAaveOracle oracle = MockAaveOracle(cfg.aaveOracle);
        assertEq(oracle.getAssetPrice(cfg.sUSDe), 123_214_617, "sUSDe price");
        assertEq(oracle.getAssetPrice(cfg.USDC), 99_968_000, "USDC price");
        assertEq(oracle.getAssetPrice(cfg.USDe), 100_000_000, "USDe price");
        assertEq(oracle.getAssetPrice(cfg.USDY), 100_000_000, "USDY price");
        assertEq(oracle.getAssetPrice(cfg.mETH), 109_297_978, "mETH price");
        assertEq(oracle.getAssetPrice(cfg.WMNT), 100_000_000, "WMNT price");
    }

    function test_HelperConfig_Sepolia_AdminHandoff() public {
        vm.chainId(5003);
        // HelperConfig uses tx.origin to identify the deployer (correct in broadcast context).
        // In a Foundry test, tx.origin == the forge-std default sender address.
        address deployer = tx.origin;
        NetworkConfig memory cfg = config.getConfig();
        MockAaveOracle oracle = MockAaveOracle(cfg.aaveOracle);
        assertTrue(
            oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), deployer), "deployer has DEFAULT_ADMIN_ROLE"
        );
        assertTrue(
            oracle.hasRole(oracle.ORACLE_ADMIN_ROLE(), deployer), "deployer has ORACLE_ADMIN_ROLE"
        );
        // HelperConfig must NOT retain admin after handoff
        assertFalse(
            oracle.hasRole(oracle.DEFAULT_ADMIN_ROLE(), address(config)),
            "HelperConfig must not retain DEFAULT_ADMIN_ROLE"
        );
        assertFalse(
            oracle.hasRole(oracle.ORACLE_ADMIN_ROLE(), address(config)),
            "HelperConfig must not retain ORACLE_ADMIN_ROLE"
        );
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
        assertEq(first.aavePool, second.aavePool, "pool not redeployed");
        assertEq(first.aaveOracle, second.aaveOracle, "oracle not redeployed");
        assertEq(first.sUSDe, second.sUSDe, "sUSDe not redeployed");
        assertEq(first.USDY, second.USDY, "USDY not redeployed");
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

    function test_SeedPrices_MatchSnapshot() public pure {
        uint256[] memory prices = SepoliaSeedPrices.getSeedPrices();
        assertEq(prices[0], 123_214_617, "sUSDe snapshot");
        assertEq(prices[1], 99_968_000, "USDC snapshot");
        assertEq(prices[2], 100_000_000, "USDe snapshot");
        assertEq(prices[3], 100_000_000, "USDY snapshot");
        assertEq(prices[4], 109_297_978, "mETH snapshot");
        assertEq(prices[5], 100_000_000, "WMNT snapshot");
    }
}
