// Aave V3 minimal ABIs (Mantle Mainnet — no Sepolia deployment per ADR-008).

import { type Abi, parseAbi } from 'viem';

// Full ReserveData + EModeCategory struct tuples from aave-v3-origin canonical
// IPool interface. Placeholder types would silently mis-decode the first 32 bytes
// of a struct as a bigint per silent-failure-hunter + type-design-analyzer findings.
export const ipoolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function setUserEMode(uint8 categoryId)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getReserveData(address asset) view returns ((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, uint40 liquidationGracePeriodUntil, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, uint128 virtualUnderlyingBalance)',
  'function getEModeCategoryData(uint8 id) view returns (uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, uint128 collateralBitmap, string label, uint128 borrowableBitmap)',
]) satisfies Abi;

export const iaaveOracleAbi = parseAbi([
  'function getAssetPrice(address asset) view returns (uint256)',
]) satisfies Abi;
