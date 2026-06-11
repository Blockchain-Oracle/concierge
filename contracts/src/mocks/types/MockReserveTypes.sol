// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Lightweight reserve configuration for MockAavePool (Sepolia mock only).
struct ReserveDataLite {
    address aToken;
    address debtToken;
    uint128 borrowRateBps; // annual borrow rate in basis points
    uint128 supplyRateBps; // annual supply rate in basis points
    uint16 ltvBps; // loan-to-value in bps (e.g. 8000 = 80%)
    uint16 liquidationThresholdBps; // liquidation threshold in bps
    bool active;
    bool borrowingEnabled;
}

/// @notice E-Mode category parameters mirroring Aave V3 mainnet values.
struct EModeCategory {
    uint16 ltvBps;
    uint16 ltBps;
    uint16 bonusBps;
    string label;
}
