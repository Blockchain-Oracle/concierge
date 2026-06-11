// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MockFaucetToken } from "./base/MockFaucetToken.sol";

/// @notice Sepolia mock of Ethena USDe. Decimals=18, faucet cap=10000 USDe per 24h.
contract MockUSDe is MockFaucetToken {
    constructor(
        address admin
    ) MockFaucetToken("USDe", "USDe", admin, 10_000e18) { }
}
