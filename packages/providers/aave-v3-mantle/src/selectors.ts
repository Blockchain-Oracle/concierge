// Pure read helpers for Aave V3 on Mantle.
// All HF values are 1e18-scaled bigints per getUserAccountData spec.

import { ipoolAbi } from '@concierge/shared/abi';
import type { Address, PublicClient } from 'viem';

export interface UserAccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint;
  ltv: bigint;
  healthFactor: bigint;
}

export async function getUserAccountData(
  publicClient: PublicClient,
  poolAddress: Address,
  user: Address,
): Promise<UserAccountData> {
  const result = await publicClient.readContract({
    address: poolAddress,
    abi: ipoolAbi,
    functionName: 'getUserAccountData',
    args: [user],
  });
  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = result;
  return {
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  };
}

export async function getHealthFactor(
  publicClient: PublicClient,
  poolAddress: Address,
  user: Address,
): Promise<bigint> {
  const data = await getUserAccountData(publicClient, poolAddress, user);
  return data.healthFactor;
}

export interface ReserveData {
  liquidityIndex: bigint;
  currentLiquidityRate: bigint;
  variableBorrowIndex: bigint;
  currentVariableBorrowRate: bigint;
  lastUpdateTimestamp: number;
  aTokenAddress: Address;
  variableDebtTokenAddress: Address;
}

export async function getReserveData(
  publicClient: PublicClient,
  poolAddress: Address,
  asset: Address,
): Promise<ReserveData> {
  const r = await publicClient.readContract({
    address: poolAddress,
    abi: ipoolAbi,
    functionName: 'getReserveData',
    args: [asset],
  });
  // viem returns getReserveData as a positional tuple; named field access is not available.
  // Indices per ipoolAbi parseAbi order: [1]=liquidityIndex, [2]=currentLiquidityRate,
  // [3]=variableBorrowIndex, [4]=currentVariableBorrowRate, [6]=lastUpdateTimestamp,
  // [9]=aTokenAddress, [11]=variableDebtTokenAddress.
  return {
    liquidityIndex: r[1],
    currentLiquidityRate: r[2],
    variableBorrowIndex: r[3],
    currentVariableBorrowRate: r[4],
    lastUpdateTimestamp: r[6],
    aTokenAddress: r[9],
    variableDebtTokenAddress: r[11],
  };
}

export interface MaxSafeBorrowOpts {
  publicClient: PublicClient;
  poolAddress: Address;
  user: Address;
  assetPrice: bigint;
  assetDecimals: number;
  targetHF: number;
}

/**
 * Pure compute: single chain read for getUserAccountData, then arithmetic.
 * Returns the borrow amount (in asset base units) that would result in HF === targetHF.
 *
 * HF formula: HF = (collateralBase × LT/10000) / (debtBase + newDebtBase)
 * Solving for newDebtBase: newDebt = (collateral × LT/10000) / targetHF − currentDebt
 * Converting to asset units: newDebtBase × 1e8 / assetPrice × 10^assetDecimals / 1e8
 */
export async function maxSafeBorrow(opts: MaxSafeBorrowOpts): Promise<bigint> {
  const { publicClient, poolAddress, user, assetPrice, assetDecimals, targetHF } = opts;
  const data = await getUserAccountData(publicClient, poolAddress, user);

  // numerator = collateralBase × LT (LT is in bps, divide by 10000)
  // targetHF is a number like 1.5 → multiply to avoid floats: use 1e4 scaling
  const TARGET_HF_SCALED = BigInt(Math.round(targetHF * 10_000));
  const numeratorLT = data.totalCollateralBase * data.currentLiquidationThreshold;
  // maxTotalDebtBase × 10000 × 10000 = collateralBase × LT × 10000 / targetHF
  // maxTotalDebtBase = collateralBase × LT / (targetHF × 10000)
  const maxTotalDebtBase = (numeratorLT * 10_000n) / (TARGET_HF_SCALED * 10_000n);
  const availableDebtBase =
    maxTotalDebtBase > data.totalDebtBase ? maxTotalDebtBase - data.totalDebtBase : 0n;

  // Convert from USD base (1e8) to asset units: availableDebtBase / assetPrice × 10^assetDecimals
  const scale = 10n ** BigInt(assetDecimals);
  return (availableDebtBase * scale) / assetPrice;
}
