// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { MockFaucetToken } from "./base/MockFaucetToken.sol";

/// @notice Sepolia mock of Wrapped MNT. Decimals=18, faucet cap=10000 WMNT per 24h.
contract MockWMNT is MockFaucetToken {
    constructor(
        address admin
    ) MockFaucetToken("Wrapped MNT", "WMNT", admin, 10_000e18) { }
}
