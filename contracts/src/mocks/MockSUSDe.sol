// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MockFaucetToken } from "./base/MockFaucetToken.sol";

/// @notice Sepolia mock of Ethena sUSDe. Decimals=18, faucet cap=1000 sUSDe per 24h.
contract MockSUSDe is MockFaucetToken {
    constructor(
        address admin
    ) MockFaucetToken("Staked USDe", "sUSDe", admin, 1000e18) { }
}
