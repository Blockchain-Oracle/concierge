// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Pure math helpers for MockAavePool — split out to keep MockAavePool under EIP-170 / 400 LOC.
/// @dev All USD values use 8-decimal base (1e8 = $1.00), matching Aave V3 oracle unit.
///      Ray (1e27) is Aave's internal rate unit; we convert bps to ray for compatibility.
library MockAavePoolLib {
    uint256 internal constant RAY = 1e27;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;
    uint256 internal constant HF_PRECISION = 1e18; // healthFactor scaled to 1e18

    /// @notice Converts basis points to ray (1e27) for Aave-compatible rate representation.
    function bpsToRay(
        uint256 bps
    ) internal pure returns (uint128) {
        // bps ≤ 10_000; RAY = 1e27; max value ≈ 1e31, well within uint128 (max ~3.4e38).
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128((bps * RAY) / BPS_DENOMINATOR);
    }

    /// @notice Accrues simple interest: principal + principal * rateBps * elapsed / SECONDS_PER_YEAR / BPS.
    /// Faithful enough for plan/simulate phases; does not implement compound IRM.
    function accrueSimpleInterest(
        uint256 principal,
        uint128 rateBps,
        uint256 lastUpdate
    ) internal view returns (uint256) {
        if (principal == 0) return 0;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= lastUpdate) return principal;
        uint256 elapsed = block.timestamp - lastUpdate;
        uint256 interest = (principal * rateBps * elapsed) / (SECONDS_PER_YEAR * BPS_DENOMINATOR);
        return principal + interest;
    }

    /// @notice Computes USD value of a token amount given an 8-decimal oracle price and token decimals.
    /// Returns value in 8-decimal USD base (1e8 = $1.00).
    function toUsdBase(
        uint256 amount,
        uint256 priceUsd8,
        uint8 decimals
    ) internal pure returns (uint256) {
        return (amount * priceUsd8) / (10 ** decimals);
    }

    /// @notice Computes health factor (1e18 scaled). HF = weightedLTNumer / totalDebtBase.
    /// @param weightedLTNumer sum of (collateral_i_usd * LT_i / BPS) across all assets.
    /// @param totalDebtBase total debt in USD 1e8 base.
    function computeHealthFactor(
        uint256 weightedLTNumer,
        uint256 totalDebtBase
    ) internal pure returns (uint256) {
        if (totalDebtBase == 0) return type(uint256).max;
        return (weightedLTNumer * HF_PRECISION) / totalDebtBase;
    }

    /// @notice Computes the effective LTV in bps for a user, given E-Mode category or general mode.
    /// Returns the override ltv if eModeId > 0, else the reserve's own ltvBps.
    function effectiveLtv(
        uint16 reserveLtvBps,
        uint16 eModeLtvBps,
        uint8 eModeId
    ) internal pure returns (uint16) {
        return eModeId > 0 ? eModeLtvBps : reserveLtvBps;
    }

    /// @notice Computes the effective liquidation threshold in bps.
    function effectiveLt(
        uint16 reserveLtBps,
        uint16 eModeLtBps,
        uint8 eModeId
    ) internal pure returns (uint16) {
        return eModeId > 0 ? eModeLtBps : reserveLtBps;
    }
}
