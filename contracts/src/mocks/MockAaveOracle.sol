// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IAaveOracle } from "@aave/interfaces/IAaveOracle.sol";
import { IPoolAddressesProvider } from "@aave/interfaces/IPoolAddressesProvider.sol";

/// @notice Errors
error AssetPriceUnavailable(address asset);
error BatchLengthMismatch();
error InvalidPrice();

/// @notice Sepolia-only mock of Aave V3 AaveOracle. Implements IAaveOracle for the Concierge
/// agent's plan + simulate phases. Reverts on unset prices (never returns 0) to mirror real Aave
/// behavior and surface agent misconfiguration bugs on Sepolia.
/// @dev Admin-tunable prices allow judge demos to simulate depeg / mETH appreciation scenarios.
contract MockAaveOracle is IAaveOracle, AccessControl {
    // ─── Roles ───────────────────────────────────────────────────────────────

    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    // ─── Events ──────────────────────────────────────────────────────────────

    event PriceUpdated(address indexed asset, uint256 oldPrice, uint256 newPrice);

    // ─── State ───────────────────────────────────────────────────────────────

    mapping(address asset => uint256 priceUsd8) internal _prices;

    constructor(
        address admin
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
    }

    // ─── IAaveOracle: admin mutations ─────────────────────────────────────────

    function setAssetPrice(
        address asset,
        uint256 priceUsd8
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (priceUsd8 == 0) revert InvalidPrice();
        uint256 old = _prices[asset];
        _prices[asset] = priceUsd8;
        emit PriceUpdated(asset, old, priceUsd8);
    }

    function setAssetPrices(
        address[] calldata assets,
        uint256[] calldata prices
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (assets.length != prices.length) revert BatchLengthMismatch();
        for (uint256 i = 0; i < assets.length; i++) {
            if (prices[i] == 0) revert InvalidPrice();
            uint256 old = _prices[assets[i]];
            _prices[assets[i]] = prices[i];
            emit PriceUpdated(assets[i], old, prices[i]);
        }
    }

    // ─── IAaveOracle: no-op stubs (unused in Sepolia playground) ─────────────

    function setAssetSources(
        address[] calldata,
        address[] calldata
    ) external onlyRole(ORACLE_ADMIN_ROLE) { }

    function setFallbackOracle(
        address
    ) external onlyRole(ORACLE_ADMIN_ROLE) { }

    // ─── IAaveOracle: read surface ────────────────────────────────────────────

    /// @dev Reverts with AssetPriceUnavailable when price is not set — NEVER returns 0 silently.
    function getAssetPrice(
        address asset
    ) external view override returns (uint256) {
        uint256 price = _prices[asset];
        if (price == 0) revert AssetPriceUnavailable(asset);
        return price;
    }

    function getAssetsPrices(
        address[] calldata assets
    ) external view override returns (uint256[] memory prices) {
        prices = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 price = _prices[assets[i]];
            if (price == 0) revert AssetPriceUnavailable(assets[i]);
            prices[i] = price;
        }
    }

    function getSourceOfAsset(
        address
    ) external view override returns (address) {
        return address(this);
    }

    function getFallbackOracle() external pure override returns (address) {
        return address(0);
    }

    function BASE_CURRENCY() external pure override returns (address) {
        return address(0); // USD base, matching real Aave Oracle
    }

    function BASE_CURRENCY_UNIT() external pure override returns (uint256) {
        return 1e8; // 8-decimal USD base
    }

    function ADDRESSES_PROVIDER() external pure override returns (IPoolAddressesProvider) {
        return IPoolAddressesProvider(address(0));
    }
}
