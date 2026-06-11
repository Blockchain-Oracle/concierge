import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { type PublicClient, parseAbi } from 'viem';

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
]);

const SECONDS_7D = 604_800;
const SECONDS_PER_YEAR = 31_536_000;

// Exchange rate of mETH in WETH (1e18-scaled) from the Agni mETH/WETH pool.
// Both tokens have 18 decimals, so there is no decimal-adjustment factor.
// token0 = mETH (18 dec), token1 = WETH (18 dec).
// sqrtPriceX96 = sqrt(rawWETH / rawMETH) * 2^96
// rate_1e18 = sqrtPriceX96^2 * 1e18 / 2^192
export function computeRateFromSqrt(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/meth-staking] computeRateFromSqrt: sqrtPriceX96 is zero — pool may be uninitialized',
    );
  }
  const Q192 = 2n ** 192n;
  const rate = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192;
  if (rate === 0n) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/meth-staking] computeRateFromSqrt: sqrtPriceX96 (${sqrtPriceX96}) too small — rate not representable`,
    );
  }
  // Sanity: mETH should be between 0.5 and 10 WETH
  const MIN_RATE = 5n * 10n ** 17n; // 0.5e18
  const MAX_RATE = 10n * 10n ** 18n; // 10e18
  if (rate < MIN_RATE || rate > MAX_RATE) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/meth-staking] computeRateFromSqrt: computed rate ${rate} outside sanity bounds [0.5e18, 10e18]`,
    );
  }
  return rate;
}

function computeYieldBps(
  currentTick: number,
  tickCumulativeNow: bigint,
  tickCumulativePast: bigint,
): number {
  const diff = tickCumulativeNow - tickCumulativePast;
  const MAX_SAFE = 9_007_199_254_740_991n;
  if (diff > MAX_SAFE || diff < -MAX_SAFE) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/meth-staking] computeYieldBps: tick cumulative diff (${diff}) outside safe integer range`,
    );
  }
  const tickCumulativeDiff = Number(diff);
  const meanTick = tickCumulativeDiff / SECONDS_7D;
  // For token0=mETH, token1=WETH: sqrtPriceX96 = sqrt(WETH/mETH), so tick rises when mETH
  // appreciates (WETH/mETH ratio increases). mETH appreciation → tick_now > meanTick_7d.
  // yieldBps = 2 * (currentTick - meanTick) * (SECONDS_PER_YEAR / SECONDS_7D)
  const tickDeviation = currentTick - meanTick;
  return Math.round(2 * tickDeviation * (SECONDS_PER_YEAR / SECONDS_7D));
}

export async function fetchPoolState(
  publicClient: PublicClient,
  pool: Address,
  tag: string,
): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  return publicClient
    .readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' })
    .then((r) => ({ sqrtPriceX96: r[0], tick: r[1] }))
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/meth-staking] ${tag}: failed to read mETH/WETH pool slot0`,
        err instanceof Error ? err : undefined,
      );
    });
}

export async function fetchYieldBps(
  publicClient: PublicClient,
  pool: Address,
  tag: string,
): Promise<number> {
  const { tick } = await fetchPoolState(publicClient, pool, tag);

  let cumulatives: readonly [readonly bigint[], readonly bigint[]];
  try {
    cumulatives = await publicClient.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: 'observe',
      args: [[0, SECONDS_7D]],
    });
  } catch (err: unknown) {
    const isOldRevert = err instanceof Error && err.message.includes('OLD');
    throw new ConciergeError(
      isOldRevert ? 'InsufficientLiquidity' : 'RpcError',
      isOldRevert
        ? `[@concierge/meth-staking] ${tag}: mETH/WETH pool has fewer than 7 days of observations — yield calculation unavailable`
        : `[@concierge/meth-staking] ${tag}: failed to call observe() on mETH/WETH pool`,
      err instanceof Error ? err : undefined,
    );
  }

  const t0 = cumulatives[0][0];
  const t1 = cumulatives[0][1];
  if (t0 === undefined || t1 === undefined) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/meth-staking] ${tag}: observe() returned fewer tick cumulatives than expected`,
    );
  }
  const yieldBps = computeYieldBps(tick, t0, t1);
  if (yieldBps <= 0) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      `[@concierge/meth-staking] ${tag}: computed mETH yield <= 0 bps (${yieldBps}) — pool may be too new or price feed unreliable`,
    );
  }
  if (yieldBps > 10_000) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/meth-staking] ${tag}: computed yield ${yieldBps} bps exceeds sanity ceiling (10,000 bps / 100% APY)`,
    );
  }
  return yieldBps;
}
