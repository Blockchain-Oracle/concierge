// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MockFaucetToken } from "./base/MockFaucetToken.sol";

/// @notice Sepolia mock of USDC. Decimals=6 (matches Mainnet), faucet cap=10,000 USDC per 24h.
contract MockUSDC is MockFaucetToken {
    constructor(
        address admin
    ) MockFaucetToken("USD Coin", "USDC", admin, 10_000e6) { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
