// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script } from "forge-std/Script.sol";

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
} from "./lib/Addresses.sol";
import { SepoliaSeedPrices } from "./lib/SepoliaSeedPrices.sol";

import { MockAavePool } from "../src/mocks/MockAavePool.sol";
import { MockAaveOracle } from "../src/mocks/MockAaveOracle.sol";
import { MockSUSDe } from "../src/mocks/MockSUSDe.sol";
import { MockUSDC } from "../src/mocks/MockUSDC.sol";
import { MockUSDe } from "../src/mocks/MockUSDe.sol";
import { MockUSDY } from "../src/mocks/MockUSDY.sol";
import { MockMETH } from "../src/mocks/MockMETH.sol";
import { MockWMNT } from "../src/mocks/MockWMNT.sol";

error UnsupportedChain(uint256 chainId);

struct NetworkConfig {
    address aavePool;
    address aaveOracle;
    address aaveAddressesProvider;
    address aaveProtocolDataProvider;
    address sUSDe;
    address USDC;
    address USDe;
    address USDY;
    address mETH;
    address WMNT;
    address erc8004Identity;
    address erc8004Reputation;
    address lifiDiamond;
    uint8 emodeStablecoinCategory;
}

contract HelperConfig is Script {
    uint256 private constant CHAIN_MAINNET = 5000;
    uint256 private constant CHAIN_SEPOLIA = 5003;

    NetworkConfig private _sepoliaConfig;
    bool private _sepoliaCached;

    function getConfig() public returns (NetworkConfig memory) {
        if (block.chainid == CHAIN_MAINNET) return _getMainnetConfig();
        if (block.chainid == CHAIN_SEPOLIA) return _getSepoliaConfig();
        revert UnsupportedChain(block.chainid);
    }

    // ─── Mainnet ──────────────────────────────────────────────────────────────

    function _getMainnetConfig() internal pure returns (NetworkConfig memory) {
        return NetworkConfig({
            aavePool: AAVE_V3_POOL_MAINNET,
            aaveOracle: AAVE_V3_ORACLE_MAINNET,
            aaveAddressesProvider: AAVE_V3_ADDRESSES_PROVIDER_MAINNET,
            aaveProtocolDataProvider: AAVE_V3_PROTOCOL_DATA_PROVIDER_MAINNET,
            sUSDe: SUSDE_MAINNET,
            USDC: USDC_MAINNET,
            USDe: USDE_MAINNET,
            USDY: USDY_MAINNET,
            mETH: METH_MAINNET,
            WMNT: WMNT_MAINNET,
            erc8004Identity: ERC8004_IDENTITY_MAINNET,
            erc8004Reputation: ERC8004_REPUTATION_MAINNET,
            lifiDiamond: LIFI_DIAMOND,
            emodeStablecoinCategory: EMODE_STABLECOIN_CATEGORY
        });
    }

    // ─── Sepolia ──────────────────────────────────────────────────────────────

    function _getSepoliaConfig() internal returns (NetworkConfig memory) {
        if (_sepoliaCached) return _sepoliaConfig;

        // tx.origin is the EOA in both test and broadcast contexts;
        // msg.sender would be the caller script contract under vm.startBroadcast.
        address deployer = tx.origin;

        // Deploy oracle with address(this) as admin so HelperConfig can seed prices,
        // then hand admin rights to the deployer.
        MockAaveOracle oracle = new MockAaveOracle(address(this));

        // Deploy mock tokens
        MockSUSDe susde = new MockSUSDe(deployer);
        MockUSDC usdc = new MockUSDC(deployer);
        MockUSDe usde = new MockUSDe(deployer);
        MockUSDY usdy = new MockUSDY(deployer);
        MockMETH meth = new MockMETH(deployer);
        MockWMNT wmnt = new MockWMNT(deployer);

        // Seed oracle with Mainnet-snapshot prices
        address[] memory assets = new address[](6);
        assets[0] = address(susde);
        assets[1] = address(usdc);
        assets[2] = address(usde);
        assets[3] = address(usdy);
        assets[4] = address(meth);
        assets[5] = address(wmnt);
        oracle.setAssetPrices(assets, SepoliaSeedPrices.getSeedPrices());

        // Hand oracle admin role to deployer so they can tune prices post-deploy,
        // then revoke this contract's own admin rights — address(this) must not retain access.
        oracle.grantRole(oracle.DEFAULT_ADMIN_ROLE(), deployer);
        oracle.grantRole(oracle.ORACLE_ADMIN_ROLE(), deployer);
        oracle.revokeRole(oracle.ORACLE_ADMIN_ROLE(), address(this));
        oracle.revokeRole(oracle.DEFAULT_ADMIN_ROLE(), address(this));

        // Deploy mock pool wired to oracle
        MockAavePool pool = new MockAavePool(address(oracle), deployer);

        _sepoliaConfig = NetworkConfig({
            aavePool: address(pool),
            aaveOracle: address(oracle),
            aaveAddressesProvider: address(0),
            aaveProtocolDataProvider: address(0),
            sUSDe: address(susde),
            USDC: address(usdc),
            USDe: address(usde),
            USDY: address(usdy),
            mETH: address(meth),
            WMNT: address(wmnt),
            erc8004Identity: ERC8004_IDENTITY_SEPOLIA,
            erc8004Reputation: ERC8004_REPUTATION_SEPOLIA,
            lifiDiamond: LIFI_DIAMOND,
            emodeStablecoinCategory: EMODE_STABLECOIN_CATEGORY
        });
        _sepoliaCached = true;
        return _sepoliaConfig;
    }
}
