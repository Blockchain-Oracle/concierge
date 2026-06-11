// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MockFaucetToken } from "./base/MockFaucetToken.sol";

/// @notice Sepolia mock of Ondo USDY. Decimals=18, faucet cap=1000 USDY per 24h.
contract MockUSDY is MockFaucetToken {
    constructor(
        address admin
    ) MockFaucetToken("Ondo U.S. Dollar Yield", "USDY", admin, 1000e18) { }
}
