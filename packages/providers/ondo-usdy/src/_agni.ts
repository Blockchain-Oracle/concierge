import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { type PublicClient, parseAbi } from 'viem';

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
]);

const SECONDS_7D = 604_800;
const SECONDS_PER_YEAR = 31_536_000;

// Price of USDY in USDC (1e18-scaled) from the Agni pool.
// token0 = USDC (6 dec, smaller address), token1 = USDY (18 dec, larger address).
// sqrtPriceX96 = sqrt(rawUSDY / rawUSDC) * 2^96
// price_usdc_per_usdy_1e18 = 10^30 * 2^192 / sqrtPriceX96^2
export function computePriceFromSqrt(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/ondo-usdy] computePriceFromSqrt: sqrtPriceX96 is zero — pool may be uninitialized',
    );
  }
  const Q192 = 2n ** 192n;
  const rawPriceUsdy = (sqrtPriceX96 * sqrtPriceX96) / Q192; // raw USDY per raw USDC
  if (rawPriceUsdy === 0n) {
    // sqrtPriceX96 < 2^96 — tick extreme (near min tick), integer truncation to zero
    throw new ConciergeError(
      'RpcError',
      `[@concierge/ondo-usdy] computePriceFromSqrt: sqrtPriceX96 (${sqrtPriceX96}) too small — price not representable`,
    );
  }
  // 10^30: compensates for 10^18 (USDY dec) / 10^6 (USDC dec) = 10^12 adjustment
  // plus 10^18 scaling of the output
  const price = 10n ** 30n / rawPriceUsdy;
  if (price === 0n) {
    // sqrtPriceX96 near max tick — denominator exceeds 10^30, result underflows
    throw new ConciergeError(
      'RpcError',
      `[@concierge/ondo-usdy] computePriceFromSqrt: sqrtPriceX96 (${sqrtPriceX96}) too large — price underflows`,
    );
  }
  return price;
}

// Annualised yield in bps from a 7-day TWAP.
// Uses tick deviation from mean: yieldBps ≈ -2 * (tick_now - meanTick_7d) * (SECONDS_PER_YEAR / 7d).
// Positive bps = USDY appreciated (tick_now < meanTick, price_raw_now < price_raw_then).
function computeYieldBps(
  currentTick: number,
  tickCumulativeNow: bigint,
  tickCumulativePast: bigint,
): number {
  const diff = tickCumulativeNow - tickCumulativePast;
  // Safety: max 7-day tick range = 887272 * 604800 ≈ 5.37e11, well within
  // Number.MAX_SAFE_INTEGER (2^53 ≈ 9e15). Bigint arithmetic first, then cast.
  if (diff > 9_007_199_254_740_991n) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/ondo-usdy] computeYieldBps: tick cumulative diff (${diff}) exceeds safe integer range`,
    );
  }
  const tickCumulativeDiff = Number(diff);
  const meanTick = tickCumulativeDiff / SECONDS_7D;
  const tickDeviation = currentTick - meanTick;
  return Math.round(-2 * tickDeviation * (SECONDS_PER_YEAR / SECONDS_7D));
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
        `[@concierge/ondo-usdy] ${tag}: failed to read USDY/USDC pool slot0`,
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
    // "OLD" revert = pool has fewer than 7 days of observations (expected business case).
    // All other failures are RPC/transport errors and should surface as such.
    const isOldRevert =
      err instanceof Error && (err.message.includes('OLD') || err.message.includes('0x001'));
    throw new ConciergeError(
      isOldRevert ? 'InsufficientLiquidity' : 'RpcError',
      isOldRevert
        ? `[@concierge/ondo-usdy] ${tag}: USDY/USDC pool has fewer than 7 days of observations — yield calculation unavailable`
        : `[@concierge/ondo-usdy] ${tag}: failed to call observe() on USDY/USDC pool`,
      err instanceof Error ? err : undefined,
    );
  }

  const yieldBps = computeYieldBps(tick, cumulatives[0][0]!, cumulatives[0][1]!);
  if (yieldBps <= 0) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      `${tag}: computed USDY yield ≤ 0 bps (${yieldBps}) — pool may be too new or price feed unreliable`,
    );
  }
  return yieldBps;
}
