// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Mainnet-snapshot prices (2026-06-03) from research/concierge/03-providers/aave-v3-mantle.md.
// Used to seed MockAaveOracle on Sepolia so demos feel real-shaped.
// 8-decimal USD base (1e8 = $1.00), matching IAaveOracle.BASE_CURRENCY_UNIT().
uint256 constant SEED_SUSDE_PRICE = 123_214_617; // $1.232 (sUSDe/USD Chainlink)
uint256 constant SEED_USDC_PRICE = 99_968_000; // $0.99968
uint256 constant SEED_USDE_PRICE = 100_000_000; // $1.00
uint256 constant SEED_USDY_PRICE = 100_000_000; // $1.00
uint256 constant SEED_METH_PRICE = 109_297_978; // $1.093 (mETH/ETH 1.0929 × $1 base)
uint256 constant SEED_WMNT_PRICE = 100_000_000; // $1.00 placeholder (WMNT not in Aave oracle)

library SepoliaSeedPrices {
    /// @notice Returns the 6 (asset, priceUsd8) pairs for MockAaveOracle seeding.
    /// The caller must pass the deployed mock addresses in the matching slot order.
    function getSeedPrices() internal pure returns (uint256[] memory prices) {
        prices = new uint256[](6);
        prices[0] = SEED_SUSDE_PRICE;
        prices[1] = SEED_USDC_PRICE;
        prices[2] = SEED_USDE_PRICE;
        prices[3] = SEED_USDY_PRICE;
        prices[4] = SEED_METH_PRICE;
        prices[5] = SEED_WMNT_PRICE;
    }
}
