// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// solhint-disable no-unused-vars

import { DataTypes } from "@aave/protocol/libraries/types/DataTypes.sol";
import { IAaveOracle } from "@aave/interfaces/IAaveOracle.sol";

import { MockAavePoolLib } from "./MockAavePoolLib.sol";
import { ReserveDataLite, EModeCategory } from "./types/MockReserveTypes.sol";

/// @notice Errors
error InsufficientCollateralLTV();
error WouldBreakHealthFactor();
error AssetNotSupported(address asset);
error BorrowingDisabled(address asset);
error InsufficientSupply();
error InsufficientDebt();

/// @notice Sepolia-only mock of Aave V3 Pool. Implements the IPool surface the Concierge agent uses.
/// Reproduces the sUSDe E-Mode 1 silent-fail trap as an explicit revert so agent bugs surface on Sepolia.
/// @dev NOT production code. No reentrancy guards by design. Simple linear interest accrual.
contract MockAavePool {
    // ─── Events ──────────────────────────────────────────────────────────────

    event Supply(
        address indexed reserve,
        address user,
        address indexed onBehalfOf,
        uint256 amount,
        uint16 indexed referralCode
    );
    event Borrow(
        address indexed reserve,
        address user,
        address indexed onBehalfOf,
        uint256 amount,
        DataTypes.InterestRateMode interestRateMode,
        uint256 borrowRate,
        uint16 indexed referralCode
    );
    event Repay(
        address indexed reserve,
        address indexed user,
        address indexed repayer,
        uint256 amount,
        bool useATokens
    );
    event Withdraw(
        address indexed reserve, address indexed user, address indexed to, uint256 amount
    );
    event UserEModeSet(address indexed user, uint8 categoryId);
    event ReserveDataUpdated(address indexed reserve, uint256 supplyRateBps, uint256 borrowRateBps);

    // ─── State ───────────────────────────────────────────────────────────────

    address public immutable oracle;
    address public immutable admin;

    mapping(address asset => ReserveDataLite) internal _reserves;
    address[] internal _reserveList;

    mapping(address user => mapping(address asset => uint256)) internal _supplies;
    mapping(address user => mapping(address asset => uint256)) internal _debts;
    mapping(address user => mapping(address asset => uint256)) internal _debtTimestamp;
    mapping(address user => uint8) internal _userEMode;
    mapping(uint8 catId => EModeCategory) internal _emodeCategories;
    mapping(address asset => uint8) internal _decimals;

    constructor(
        address _oracle,
        address _admin
    ) {
        oracle = _oracle;
        admin = _admin;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    // ─── Admin: reserve + eMode setup ────────────────────────────────────────

    function mockInitReserve(
        address asset,
        uint8 decimals_,
        address aToken,
        address debtToken,
        uint128 supplyRateBps,
        uint128 borrowRateBps,
        uint16 ltvBps,
        uint16 liquidationThresholdBps,
        bool borrowingEnabled
    ) external onlyAdmin {
        require(ltvBps <= liquidationThresholdBps, "ltv>lt");
        if (_reserves[asset].aToken == address(0)) _reserveList.push(asset);
        _reserves[asset] = ReserveDataLite({
            aToken: aToken,
            debtToken: debtToken,
            borrowRateBps: borrowRateBps,
            supplyRateBps: supplyRateBps,
            ltvBps: ltvBps,
            liquidationThresholdBps: liquidationThresholdBps,
            active: true,
            borrowingEnabled: borrowingEnabled
        });
        _decimals[asset] = decimals_;
        emit ReserveDataUpdated(asset, supplyRateBps, borrowRateBps);
    }

    function mockSetReserveData(
        address asset,
        uint128 supplyRateBps,
        uint128 borrowRateBps
    ) external onlyAdmin {
        _reserves[asset].supplyRateBps = supplyRateBps;
        _reserves[asset].borrowRateBps = borrowRateBps;
        emit ReserveDataUpdated(asset, supplyRateBps, borrowRateBps);
    }

    function mockSetEmodeCategory(
        uint8 catId,
        uint16 ltvBps,
        uint16 ltBps,
        uint16 bonusBps,
        string calldata label
    ) external onlyAdmin {
        _emodeCategories[catId] =
            EModeCategory({ ltvBps: ltvBps, ltBps: ltBps, bonusBps: bonusBps, label: label });
    }

    // ─── IPool: supply / withdraw / borrow / repay / setUserEMode ─────────────

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external {
        if (!_reserves[asset].active) revert AssetNotSupported(asset);
        _supplies[onBehalfOf][asset] += amount;
        emit Supply(asset, msg.sender, onBehalfOf, amount, referralCode);
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256) {
        if (!_reserves[asset].active) revert AssetNotSupported(asset);
        uint256 bal = _supplies[msg.sender][asset];
        uint256 actual = amount == type(uint256).max ? bal : amount;
        if (actual > bal) revert InsufficientSupply();
        _supplies[msg.sender][asset] = bal - actual;
        if (_hasDebt(msg.sender)) {
            (,,,,, uint256 hf) = _computeAccountData(msg.sender);
            if (hf < 1e18) revert WouldBreakHealthFactor();
        }
        emit Withdraw(asset, msg.sender, to, actual);
        return actual;
    }

    function borrow(
        address asset,
        uint256 amount,
        uint256, /* interestRateMode */
        uint16 referralCode,
        address onBehalfOf
    ) external {
        ReserveDataLite storage r = _reserves[asset];
        if (!r.active) revert AssetNotSupported(asset);
        if (!r.borrowingEnabled) revert BorrowingDisabled(asset);
        _requireSufficientCollateral(onBehalfOf, asset, amount);
        _debts[onBehalfOf][asset] = _currentDebt(onBehalfOf, asset) + amount;
        _debtTimestamp[onBehalfOf][asset] = block.timestamp;
        emit Borrow(
            asset,
            msg.sender,
            onBehalfOf,
            amount,
            DataTypes.InterestRateMode.VARIABLE,
            MockAavePoolLib.bpsToRay(r.borrowRateBps),
            referralCode
        );
    }

    function repay(
        address asset,
        uint256 amount,
        uint256, /* interestRateMode */
        address onBehalfOf
    ) external returns (uint256) {
        if (!_reserves[asset].active) revert AssetNotSupported(asset);
        uint256 debt = _currentDebt(onBehalfOf, asset);
        if (debt == 0) revert InsufficientDebt();
        uint256 actual = (amount == type(uint256).max || amount > debt) ? debt : amount;
        _debts[onBehalfOf][asset] = debt - actual;
        _debtTimestamp[onBehalfOf][asset] = (debt == actual) ? 0 : block.timestamp;
        emit Repay(asset, onBehalfOf, msg.sender, actual, false);
        return actual;
    }

    function setUserEMode(
        uint8 categoryId
    ) external {
        _userEMode[msg.sender] = categoryId;
        emit UserEModeSet(msg.sender, categoryId);
    }

    function setUserUseReserveAsCollateral(
        address,
        bool
    ) external { }

    // ─── IPool: read surface ──────────────────────────────────────────────────

    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        return _computeAccountData(user);
    }

    function getReserveData(
        address asset
    ) external view returns (DataTypes.ReserveDataLegacy memory data) {
        if (!_reserves[asset].active) revert AssetNotSupported(asset);
        ReserveDataLite storage r = _reserves[asset];
        data.aTokenAddress = r.aToken;
        data.variableDebtTokenAddress = r.debtToken;
        data.currentLiquidityRate = MockAavePoolLib.bpsToRay(r.supplyRateBps);
        data.currentVariableBorrowRate = MockAavePoolLib.bpsToRay(r.borrowRateBps);
        data.liquidityIndex = uint128(MockAavePoolLib.RAY);
        data.variableBorrowIndex = uint128(MockAavePoolLib.RAY);
        data.lastUpdateTimestamp = uint40(block.timestamp);
    }

    function getEModeCategoryData(
        uint8 id
    ) external view returns (DataTypes.EModeCategoryLegacy memory) {
        EModeCategory storage c = _emodeCategories[id];
        return DataTypes.EModeCategoryLegacy({
            ltv: c.ltvBps,
            liquidationThreshold: c.ltBps,
            liquidationBonus: c.bonusBps,
            priceSource: address(0),
            label: c.label
        });
    }

    function getReservesList() external view returns (address[] memory) {
        return _reserveList;
    }

    function getReservesCount() external view returns (uint256) {
        return _reserveList.length;
    }

    function getReserveConfigurationData(
        address asset
    )
        external
        view
        returns (
            uint256 decimals_,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        )
    {
        if (!_reserves[asset].active) revert AssetNotSupported(asset);
        ReserveDataLite storage r = _reserves[asset];
        decimals_ = _decimals[asset];
        ltv = r.ltvBps;
        liquidationThreshold = r.liquidationThresholdBps;
        liquidationBonus = 0;
        reserveFactor = 0;
        usageAsCollateralEnabled = true;
        borrowingEnabled = r.borrowingEnabled;
        stableBorrowRateEnabled = false;
        isActive = r.active;
        isFrozen = false;
    }

    function getUserEMode(
        address user
    ) external view returns (uint256) {
        return _userEMode[user];
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    function _currentDebt(
        address user,
        address asset
    ) internal view returns (uint256) {
        uint256 principal = _debts[user][asset];
        uint256 ts = _debtTimestamp[user][asset];
        if (principal == 0 || ts == 0) return 0;
        return MockAavePoolLib.accrueSimpleInterest(principal, _reserves[asset].borrowRateBps, ts);
    }

    function _hasDebt(
        address user
    ) internal view returns (bool) {
        for (uint256 i = 0; i < _reserveList.length; i++) {
            if (_debts[user][_reserveList[i]] > 0) return true;
        }
        return false;
    }

    function _computeSupplySide(
        address user,
        uint8 eModeId
    ) internal view returns (uint256 totalCollateral, uint256 weightedLT, uint256 weightedLTV) {
        EModeCategory storage eMode = _emodeCategories[eModeId];
        for (uint256 i = 0; i < _reserveList.length; i++) {
            address asset = _reserveList[i];
            uint256 supplyAmt = _supplies[user][asset];
            if (supplyAmt == 0) continue;
            uint256 price = IAaveOracle(oracle).getAssetPrice(asset);
            uint256 supplyUsd = MockAavePoolLib.toUsdBase(supplyAmt, price, _decimals[asset]);
            totalCollateral += supplyUsd;
            uint16 lt = MockAavePoolLib.effectiveLt(
                _reserves[asset].liquidationThresholdBps, eMode.ltBps, eModeId
            );
            weightedLT += (supplyUsd * lt) / MockAavePoolLib.BPS_DENOMINATOR;
            uint16 ltvBps =
                MockAavePoolLib.effectiveLtv(_reserves[asset].ltvBps, eMode.ltvBps, eModeId);
            weightedLTV += (supplyUsd * ltvBps) / MockAavePoolLib.BPS_DENOMINATOR;
        }
    }

    function _computeDebtSide(
        address user
    ) internal view returns (uint256 totalDebt) {
        for (uint256 i = 0; i < _reserveList.length; i++) {
            address asset = _reserveList[i];
            uint256 debtAmt = _currentDebt(user, asset);
            if (debtAmt == 0) continue;
            uint256 price = IAaveOracle(oracle).getAssetPrice(asset);
            totalDebt += MockAavePoolLib.toUsdBase(debtAmt, price, _decimals[asset]);
        }
    }

    function _computeAccountData(
        address user
    )
        internal
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        uint8 eModeId = _userEMode[user];
        (uint256 collateral, uint256 wLT, uint256 wLTV) = _computeSupplySide(user, eModeId);
        uint256 debt = _computeDebtSide(user);

        totalCollateralBase = collateral;
        totalDebtBase = debt;
        if (collateral > 0) {
            currentLiquidationThreshold = (wLT * MockAavePoolLib.BPS_DENOMINATOR) / collateral;
            ltv = (wLTV * MockAavePoolLib.BPS_DENOMINATOR) / collateral;
        }
        availableBorrowsBase = wLTV > debt ? wLTV - debt : 0;
        healthFactor = MockAavePoolLib.computeHealthFactor(wLT, debt);
    }

    function _requireSufficientCollateral(
        address user,
        address borrowAsset,
        uint256 amount
    ) internal view {
        uint256 priceUsd8 = IAaveOracle(oracle).getAssetPrice(borrowAsset);
        uint256 borrowUsd = MockAavePoolLib.toUsdBase(amount, priceUsd8, _decimals[borrowAsset]);
        (,, uint256 avail,,,) = _computeAccountData(user);
        if (borrowUsd > avail) revert InsufficientCollateralLTV();
    }
}
