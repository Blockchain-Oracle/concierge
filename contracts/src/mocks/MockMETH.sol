// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MockFaucetToken } from "./base/MockFaucetToken.sol";

/// @notice Sepolia mock of Mantle mETH. Decimals=18, faucet cap=5 mETH per 24h.
contract MockMETH is MockFaucetToken {
    constructor(
        address admin
    ) MockFaucetToken("mETH", "mETH", admin, 5e18) { }
}
