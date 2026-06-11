// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";

import { DataTypes } from "@aave/protocol/libraries/types/DataTypes.sol";
import { MockAavePool } from "../../src/mocks/MockAavePool.sol";
import { MockAavePoolLib } from "../../src/mocks/MockAavePoolLib.sol";
import {
    InsufficientCollateralLTV,
    WouldBreakHealthFactor,
    InsufficientSupply,
    InsufficientDebt,
    AssetNotSupported,
    BorrowingDisabled
} from "../../src/mocks/MockAavePool.sol";

/// @notice Minimal price oracle for unit tests — returns fixed USD prices (8-decimal base).
contract FixedPriceOracle {
    mapping(address => uint256) internal _prices;

    function setPrice(
        address asset,
        uint256 priceUsd8
    ) external {
        _prices[asset] = priceUsd8;
    }

    function getAssetPrice(
        address asset
    ) external view returns (uint256) {
        return _prices[asset];
    }
}

/// forge-config: default.fuzz.runs = 256
contract MockAavePoolTest is Test {
    MockAavePool internal pool;
    FixedPriceOracle internal oracle;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    // Token addresses (no real ERC-20 needed — pool tracks balances internally)
    address internal sUSDe = makeAddr("sUSDe");
    address internal USDC = makeAddr("USDC");
    address internal USDe = makeAddr("USDe");
    address internal USDY = makeAddr("USDY");
    address internal mETH = makeAddr("mETH");

    // E-Mode 1 params from Mainnet (research/concierge/03-providers/aave-v3-mantle.md)
    uint16 internal constant EMODE1_LTV = 9000;
    uint16 internal constant EMODE1_LT = 9200;
    uint16 internal constant EMODE1_BONUS = 10_400;

    function setUp() public {
        oracle = new FixedPriceOracle();
        pool = new MockAavePool(address(oracle), admin);

        // Prices: sUSDe = $1.232, USDC = $1.00, USDe = $1.00, USDY = $1.00, mETH = $3000
        oracle.setPrice(sUSDe, 123_200_000); // $1.232 * 1e8
        oracle.setPrice(USDC, 100_000_000); // $1.00
        oracle.setPrice(USDe, 100_000_000);
        oracle.setPrice(USDY, 100_000_000);
        oracle.setPrice(mETH, 300_000_000_000); // $3000

        vm.startPrank(admin);
        // sUSDe: LTV=0 in general mode (E-Mode trap), active, NOT borrowing-enabled, eMode cat 1
        pool.mockInitReserve(
            sUSDe, 18, makeAddr("aSUSDe"), makeAddr("dSUSDe"), 200, 0, 0, 0, false, 1
        );
        pool.mockInitReserve(
            USDC, 6, makeAddr("aUSDC"), makeAddr("dUSDC"), 400, 500, 7500, 8000, true, 1
        );
        pool.mockInitReserve(
            USDe, 18, makeAddr("aUSDe"), makeAddr("dUSDe"), 350, 400, 7500, 8000, true, 1
        );
        pool.mockInitReserve(
            USDY, 18, makeAddr("aUSDY"), makeAddr("dUSDY"), 350, 400, 7500, 8000, true, 1
        );
        // mETH is NOT in E-Mode 1 — eModeCategoryId=0 ensures its LTV/LT is unaffected by eMode
        pool.mockInitReserve(
            mETH, 18, makeAddr("amETH"), makeAddr("dmETH"), 250, 350, 7000, 7500, true, 0
        );
        // E-Mode 1: "sUSDe Stablecoins" (verified from Mantle Mainnet)
        pool.mockSetEmodeCategory(1, EMODE1_LTV, EMODE1_LT, EMODE1_BONUS, "sUSDe Stablecoins");
        vm.stopPrank();
    }

    // ─── Reserves ────────────────────────────────────────────────────────────

    function test_getReservesList_ReturnsFiveAssets() public view {
        address[] memory list = pool.getReservesList();
        assertEq(list.length, 5);
        assertEq(list[0], sUSDe);
        assertEq(list[1], USDC);
        assertEq(list[2], USDe);
        assertEq(list[3], USDY);
        assertEq(list[4], mETH);
    }

    function test_getReservesCount_ReturnsFive() public view {
        assertEq(pool.getReservesCount(), 5);
    }

    // ─── E-Mode ──────────────────────────────────────────────────────────────

    function test_getEModeCategoryData_ReturnsMainnetValues() public view {
        DataTypes.EModeCategoryLegacy memory eMode = pool.getEModeCategoryData(1);
        assertEq(eMode.ltv, EMODE1_LTV, "ltv");
        assertEq(eMode.liquidationThreshold, EMODE1_LT, "lt");
        assertEq(eMode.liquidationBonus, EMODE1_BONUS, "bonus");
        assertEq(eMode.label, "sUSDe Stablecoins", "label");
    }

    // ─── E-Mode 1 silent-fail trap ───────────────────────────────────────────

    /// sUSDe LTV=0 in general mode → borrow must revert (reproduces Mainnet silent-fail).
    function test_borrow_RevertsWhenSusdeWithoutEMode() public {
        vm.prank(alice);
        pool.supply(sUSDe, 1000e18, alice, 0);

        vm.prank(alice);
        vm.expectRevert(InsufficientCollateralLTV.selector);
        pool.borrow(USDC, 100e6, 2, 0, alice);
    }

    /// After setUserEMode(1), sUSDe LTV=90% → borrow succeeds.
    function test_borrow_SucceedsAfterSetUserEMode1() public {
        vm.prank(alice);
        pool.supply(sUSDe, 1000e18, alice, 0); // supply 1000 sUSDe ≈ $1232

        vm.prank(alice);
        pool.setUserEMode(1);

        // Available to borrow: $1232 * 90% = $1108.8 → up to ~1108 USDC
        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice); // borrow 100 USDC — should succeed
        // Verify debt tracked
        (, uint256 debtBase,,,,) = pool.getUserAccountData(alice);
        assertGt(debtBase, 0);
    }

    function test_setUserEMode_UpdatesUserCategory() public {
        vm.prank(alice);
        pool.setUserEMode(1);
        assertEq(pool.getUserEMode(alice), 1);
    }

    // ─── Supply / Withdraw ────────────────────────────────────────────────────

    function test_supply_IncreasesCollateral() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0);
        (uint256 collateral,,,,,) = pool.getUserAccountData(alice);
        // 1000 USDC @ $1 = $1000 base (8-decimal: 1000e8)
        assertEq(collateral, 1000e8);
    }

    function test_withdraw_ReducesCollateral() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0);
        vm.prank(alice);
        pool.withdraw(USDC, 500e6, alice);
        (uint256 collateral,,,,,) = pool.getUserAccountData(alice);
        assertEq(collateral, 500e8);
    }

    function test_withdraw_AllWithMaxUint() public {
        vm.prank(alice);
        pool.supply(USDC, 500e6, alice, 0);
        vm.prank(alice);
        uint256 withdrawn = pool.withdraw(USDC, type(uint256).max, alice);
        assertEq(withdrawn, 500e6);
        (uint256 collateral,,,,,) = pool.getUserAccountData(alice);
        assertEq(collateral, 0);
    }

    function test_withdraw_RevertsWhenBreaksHealthFactor() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0); // $1000 collateral

        vm.prank(alice);
        pool.borrow(USDC, 500e6, 2, 0, alice); // borrow $500, HF ≈ 1.6

        // Try to withdraw all — would drop HF below 1
        vm.prank(alice);
        vm.expectRevert(WouldBreakHealthFactor.selector);
        pool.withdraw(USDC, 1000e6, alice);
    }

    // ─── getUserAccountData / healthFactor ────────────────────────────────────

    /// USDC LT=8000 (80%); HF = 200e8 * 80% / 100e8 = 1.6e18 (±1e15 precision).
    function test_getUserAccountData_HealthFactorCorrect() public {
        vm.prank(alice);
        pool.supply(USDC, 200e6, alice, 0); // $200 collateral (USDC @ $1)

        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice); // $100 debt

        (,,, uint256 lt,, uint256 hf) = pool.getUserAccountData(alice);
        // LT for USDC = 8000 (80%); HF = 200e8 * 80% / 100e8 = 1.6e18
        assertEq(lt, 8000, "lt");
        assertApproxEqAbs(hf, 1.6e18, 1e15, "hf");
    }

    /// With USDC LT=8000 and totalCollateral=$200, totalDebt=$100: HF = 200*0.80/100 = 1.6.
    function test_getUserAccountData_AvailableBorrowsReflectsLTV() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0); // $1000 collateral, LTV=75%

        (,, uint256 avail,,,) = pool.getUserAccountData(alice);
        // Available = 1000e8 * 7500 / 10000 = 750e8
        assertEq(avail, 750e8);
    }

    // ─── Repay ────────────────────────────────────────────────────────────────

    function test_repay_ClearsDebt() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0);
        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice);

        vm.prank(alice);
        pool.repay(USDC, type(uint256).max, 2, alice);

        (, uint256 debt,,,,) = pool.getUserAccountData(alice);
        assertEq(debt, 0);
    }

    // ─── getReserveData ───────────────────────────────────────────────────────

    function test_getReserveData_ReturnsRates() public view {
        // USDC: supplyRateBps=400, borrowRateBps=500
        uint256 expectedSupplyRay = (400 * MockAavePoolLib.RAY) / 10_000;
        uint256 expectedBorrowRay = (500 * MockAavePoolLib.RAY) / 10_000;
        DataTypes.ReserveDataLegacy memory rd = pool.getReserveData(USDC);
        assertEq(rd.currentLiquidityRate, expectedSupplyRay, "supplyRate");
        assertEq(rd.currentVariableBorrowRate, expectedBorrowRay, "borrowRate");
    }

    // ─── mockSetReserveData ───────────────────────────────────────────────────

    function test_mockSetReserveData_UpdatesRates() public {
        vm.prank(admin);
        pool.mockSetReserveData(USDC, 600, 700);
        DataTypes.ReserveDataLegacy memory rd = pool.getReserveData(USDC);
        assertEq(rd.currentLiquidityRate, (600 * MockAavePoolLib.RAY) / 10_000, "new supplyRate");
        assertEq(
            rd.currentVariableBorrowRate, (700 * MockAavePoolLib.RAY) / 10_000, "new borrowRate"
        );
    }

    // ─── getReserveConfigurationData ─────────────────────────────────────────

    function test_getReserveConfigurationData_ReturnsCorrectFlags() public view {
        (
            uint256 decimals_,
            uint256 ltv,
            uint256 liquidationThreshold,,,
            bool usageAsCollateral,
            bool borrowingEnabled,,
            bool isActive,
        ) = pool.getReserveConfigurationData(USDC);
        assertEq(decimals_, 6, "decimals");
        assertEq(ltv, 7500, "ltv");
        assertEq(liquidationThreshold, 8000, "lt");
        assertTrue(usageAsCollateral, "usageAsCollateral");
        assertTrue(borrowingEnabled, "borrowingEnabled");
        assertTrue(isActive, "isActive");
    }

    function test_getReserveConfigurationData_SusdeNotBorrowable() public view {
        (,,,,,, bool borrowingEnabled,,,) = pool.getReserveConfigurationData(sUSDe);
        assertFalse(borrowingEnabled, "sUSDe should not be borrowable");
    }

    // ─── Admin access control ─────────────────────────────────────────────────

    function test_mockInitReserve_RevertsForNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert("not admin");
        pool.mockInitReserve(USDC, 6, address(1), address(2), 0, 0, 0, 0, false, 0);
    }

    function test_mockSetReserveData_RevertsForNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert("not admin");
        pool.mockSetReserveData(USDC, 600, 700);
    }

    function test_mockSetEmodeCategory_RevertsForNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert("not admin");
        pool.mockSetEmodeCategory(2, 8000, 8500, 10_500, "test");
    }

    // ─── Error reverts ────────────────────────────────────────────────────────

    function test_supply_RevertsForUnknownAsset() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetNotSupported.selector, makeAddr("unknown")));
        pool.supply(makeAddr("unknown"), 100e6, alice, 0);
    }

    function test_borrow_RevertsWhenBorrowingDisabled() public {
        vm.prank(alice);
        pool.supply(sUSDe, 1000e18, alice, 0);
        vm.prank(alice);
        pool.setUserEMode(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BorrowingDisabled.selector, sUSDe));
        pool.borrow(sUSDe, 1e18, 2, 0, alice);
    }

    function test_withdraw_RevertsWhenInsufficientSupply() public {
        vm.prank(alice);
        pool.supply(USDC, 100e6, alice, 0);
        vm.prank(alice);
        vm.expectRevert(InsufficientSupply.selector);
        pool.withdraw(USDC, 200e6, alice);
    }

    function test_repay_RevertsWhenNoDebt() public {
        vm.prank(alice);
        vm.expectRevert(InsufficientDebt.selector);
        pool.repay(USDC, 100e6, 2, alice);
    }

    // ─── Interest accrual ─────────────────────────────────────────────────────

    function test_debt_AccruesSimpleInterestOverOneYear() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0); // $1000 collateral
        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice); // 100 USDC @ 5% borrow rate

        vm.warp(block.timestamp + 365 days);

        (, uint256 debtBase,,,,) = pool.getUserAccountData(alice);
        // 100 USDC @ $1 = $100 → 100e8 base; 5% interest → 105e8 after 1 year
        assertApproxEqAbs(debtBase, 105e8, 1e8, "debt should accrue 5% over 1 year");
    }

    function test_repay_PartialResetsTimestampForFutureAccrual() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0);
        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice); // 100 USDC principal

        vm.warp(block.timestamp + 365 days); // 5 USDC accrued → debt = 105 USDC
        vm.prank(alice);
        pool.repay(USDC, 50e6, 2, alice); // partial repay — remaining debt ~55 USDC

        // After another year the remaining should grow by ~5%, not by 2 years of interest
        vm.warp(block.timestamp + 365 days);
        (, uint256 debtBase,,,,) = pool.getUserAccountData(alice);
        // ~55 USDC * 1.05 ≈ 57.75 USDC → 5775e6 → 5775e8 base (price $1, 6 dec)
        assertLt(debtBase, 60e8, "should not double-charge pre-repay interest");
        assertGt(debtBase, 54e8, "should still accrue post-repay interest");
    }

    // ─── E-Mode HF computation ────────────────────────────────────────────────

    function test_emode1_HealthFactorUsesEmodeLT() public {
        vm.prank(alice);
        pool.supply(sUSDe, 1000e18, alice, 0); // ~$1232 collateral
        vm.prank(alice);
        pool.setUserEMode(1);
        vm.prank(alice);
        pool.borrow(USDe, 500e18, 2, 0, alice); // $500 debt

        (,,, uint256 lt,, uint256 hf) = pool.getUserAccountData(alice);
        // E-Mode LT=9200 → HF = 1232 * 0.92 / 500 ≈ 2.27
        assertEq(lt, EMODE1_LT, "should use E-Mode LT override");
        assertGt(hf, 2e18, "hf should reflect E-Mode LT");
    }

    function test_setUserEMode0_DropsBorrowCapacity() public {
        vm.prank(alice);
        pool.supply(sUSDe, 1000e18, alice, 0); // ~$1232 collateral
        vm.prank(alice);
        pool.setUserEMode(1);
        (,, uint256 availEMode,,,) = pool.getUserAccountData(alice);
        assertGt(availEMode, 0, "emode should have borrow capacity");

        vm.prank(alice);
        pool.setUserEMode(0);
        (,, uint256 availGeneral,,,) = pool.getUserAccountData(alice);
        // sUSDe ltvBps=0 in general mode → avail=0
        assertEq(availGeneral, 0, "general mode sUSDe should have 0 borrow capacity");
        assertGt(availEMode, availGeneral, "emode capacity > general mode capacity");
    }

    // ─── E-Mode category membership ───────────────────────────────────────────

    /// mETH is NOT in E-Mode 1 — its LTV/LT must stay at its reserve values even with eMode=1.
    function test_emode1_NonMemberAssetKeepsReserveLTV() public {
        vm.prank(alice);
        pool.supply(mETH, 1e18, alice, 0); // $3000 collateral
        vm.prank(alice);
        pool.setUserEMode(1);
        (,, uint256 avail,,, uint256 hf) = pool.getUserAccountData(alice);
        // mETH ltvBps=7000 (not overridden to 9000); avail = 3000e8 * 7000/10000 = 2100e8
        assertEq(avail, 2100e8, "mETH LTV must stay at 70% in eMode-1");
        assertEq(hf, type(uint256).max, "no debt yet");
    }

    function test_setUserEMode_RevertsIfWouldBreakHF() public {
        vm.prank(alice);
        pool.supply(sUSDe, 1000e18, alice, 0); // ~$1232
        vm.prank(alice);
        pool.setUserEMode(1);
        vm.prank(alice);
        pool.borrow(USDe, 500e18, 2, 0, alice); // $500 debt, HF ≈ 2.27 in eMode-1

        // Downgrading to eMode-0 makes sUSDe LT=0 → HF collapses
        vm.prank(alice);
        vm.expectRevert(WouldBreakHealthFactor.selector);
        pool.setUserEMode(0);
    }

    // ─── setUserUseReserveAsCollateral ────────────────────────────────────────

    function test_setUserUseReserveAsCollateral_ExcludesFromCollateral() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0);
        (uint256 before,,,,,) = pool.getUserAccountData(alice);
        assertEq(before, 1000e8);

        vm.prank(alice);
        pool.setUserUseReserveAsCollateral(USDC, false);
        (uint256 after_,,,,,) = pool.getUserAccountData(alice);
        assertEq(after_, 0, "excluded asset should not count as collateral");
    }

    function test_setUserUseReserveAsCollateral_ReenablesCollateral() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0);
        vm.prank(alice);
        pool.setUserUseReserveAsCollateral(USDC, false);
        vm.prank(alice);
        pool.setUserUseReserveAsCollateral(USDC, true);
        (uint256 collateral,,,,,) = pool.getUserAccountData(alice);
        assertEq(collateral, 1000e8, "re-enabled collateral should count again");
    }

    // ─── Multi-asset HF aggregation ───────────────────────────────────────────

    function test_getUserAccountData_MultiAssetCollateral() public {
        vm.prank(alice);
        pool.supply(USDC, 500e6, alice, 0); // $500, LTV=75%, LT=80%
        vm.prank(alice);
        pool.supply(mETH, 1e18, alice, 0); // $3000, LTV=70%, LT=75%

        (uint256 collateral,, uint256 avail, uint256 lt,,) = pool.getUserAccountData(alice);
        assertEq(collateral, 3500e8, "total collateral");
        // avail = 500e8*7500/10000 + 3000e8*7000/10000 = 375e8 + 2100e8 = 2475e8
        assertEq(avail, 2475e8, "available borrows aggregated");
        // weightedLT = (500e8*8000 + 3000e8*7500) / 3500e8 = (4000e8 + 22500e8) / 3500e8 * 10000
        // = 26500e8 / 3500e8 * 10000 = 7571 (truncated)
        assertApproxEqAbs(lt, 7571, 1, "weighted LT aggregated");
    }

    // ─── Second-borrow interest checkpoint (regression for C-1 fix) ───────────

    function test_borrow_CheckpointsAccruedInterestOnSecondBorrow() public {
        vm.prank(alice);
        pool.supply(USDC, 2000e6, alice, 0);
        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice); // 100 USDC @ 5% borrow rate

        vm.warp(block.timestamp + 365 days); // 5 USDC accrued → debt ≈ 105 USDC

        vm.prank(alice);
        pool.borrow(USDC, 100e6, 2, 0, alice); // checkpoint 105 + 100 = 205 USDC

        vm.warp(block.timestamp + 365 days); // 205 * 5% = 10.25 → debt ≈ 215.25 USDC

        (, uint256 debtBase,,,,) = pool.getUserAccountData(alice);
        // 215 USDC @ $1 = 215e8 base; second borrow must have captured the first year's interest
        assertApproxEqAbs(debtBase, 215e8, 2e8, "second borrow must checkpoint accrued interest");
    }

    function test_borrow_RespectsExistingDebt() public {
        vm.prank(alice);
        pool.supply(USDC, 1000e6, alice, 0); // $1000, LTV=75% → avail $750
        vm.prank(alice);
        pool.borrow(USDC, 700e6, 2, 0, alice); // avail now ≈ $50

        vm.prank(alice);
        vm.expectRevert(InsufficientCollateralLTV.selector);
        pool.borrow(USDC, 100e6, 2, 0, alice); // $100 > remaining avail → revert

        vm.prank(alice);
        pool.borrow(USDC, 40e6, 2, 0, alice); // $40 ≤ avail → succeed
    }
}
