import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import { computePriceFromSqrt, fetchPoolState, fetchYieldBps } from '../../_agni.ts';

const POOL = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;

// sqrtPriceX96 corresponding to USDY ≈ $1.0617 (from real Mantle state 2026-06-11).
// token0 = USDC (6 dec), token1 = USDY (18 dec).
const SQRT_PRICE = 76893643322421959054268744908233200n;
// Tick corresponding to roughly $1.0617 USDY/USDC.
const TICK = 275725;

function makeClient(slot0Result: unknown, observeResult?: unknown, observeError?: Error) {
  return {
    readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
      if (functionName === 'slot0') return Promise.resolve(slot0Result);
      if (functionName === 'observe') {
        if (observeError) return Promise.reject(observeError);
        return Promise.resolve(observeResult);
      }
      return Promise.reject(new Error(`Unexpected: ${functionName}`));
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  } as any;
}

describe('computePriceFromSqrt', () => {
  it('returns ~1.0617e18 for the real Mantle USDY/USDC sqrtPriceX96', () => {
    const price = computePriceFromSqrt(SQRT_PRICE);
    // price should be ≈ 1_061_700_000_000_000_000 (i.e. $1.0617)
    expect(price).toBeGreaterThan(1_050_000_000_000_000_000n);
    expect(price).toBeLessThan(1_080_000_000_000_000_000n);
  });

  it('throws ConciergeError(RpcError) for sqrtPriceX96 = 0 (uninitialized pool)', () => {
    let thrown: unknown;
    try {
      computePriceFromSqrt(0n);
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof ConciergeError && (thrown as ConciergeError).type === 'RpcError').toBe(
      true,
    );
  });

  it('throws ConciergeError(RpcError) when sqrtPriceX96 is too small (integer truncation)', () => {
    // sqrtPriceX96 = 1n: (1n * 1n) / 2^192 = 0 — triggers truncation guard
    let thrown: unknown;
    try {
      computePriceFromSqrt(1n);
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof ConciergeError && (thrown as ConciergeError).type === 'RpcError').toBe(
      true,
    );
  });
});

describe('fetchPoolState', () => {
  it('returns sqrtPriceX96 and tick from slot0', async () => {
    const client = makeClient([SQRT_PRICE, TICK, 0, 1, 1, 0, true]);
    const result = await fetchPoolState(client, POOL, 'test');
    expect(result.sqrtPriceX96).toBe(SQRT_PRICE);
    expect(result.tick).toBe(TICK);
  });

  it('throws ConciergeError(RpcError) when slot0 reverts', async () => {
    const client = makeClient(undefined);
    client.readContract = vi.fn().mockRejectedValue(new Error('revert'));
    await expect(fetchPoolState(client, POOL, 'test')).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('fetchYieldBps', () => {
  // Synthetic tick cumulatives representing ~500 bps APY over 7 days.
  // For USDY appreciation: tick decreases → tick_past > tick_now.
  // yieldBps ≈ -2 * (tick_now - meanTick) * (SECONDS_PER_YEAR / 7d)
  // For yieldBps = 500: tickDeviation = -4.795 → meanTick = tick_now + 4.795 = 275729.795
  // tickCumulativeDiff = meanTick * 604800 = 275729.795 * 604800 ≈ 166_761_500_000
  // observe([0, 7d]) returns [cumulative_now, cumulative_7d_ago]
  // cumulative_now > cumulative_7d_ago (tick was higher in the past = USDY cheaper)

  const TICK_CUMULATIVE_NOW = 23_000_000_000_000n;
  // tickCumulativeDiff ≈ 166_761_500_000 to give ~500 bps
  const TICK_CUMULATIVE_7D = TICK_CUMULATIVE_NOW - 166_761_500_000n;

  it('returns ~500 bps for synthetic 7-day tick data representing 5% APY', async () => {
    const slot0 = [SQRT_PRICE, TICK, 0, 1, 1, 0, true];
    const observeResult = [
      [TICK_CUMULATIVE_NOW, TICK_CUMULATIVE_7D],
      [0n, 0n],
    ];
    const client = makeClient(slot0, observeResult);
    const yieldBps = await fetchYieldBps(client, POOL, 'test');
    // Allow ±50 bps tolerance for rounding
    expect(yieldBps).toBeGreaterThanOrEqual(450);
    expect(yieldBps).toBeLessThanOrEqual(550);
  });

  it('throws ConciergeError(InsufficientLiquidity) when observe reverts with OLD', async () => {
    const slot0 = [SQRT_PRICE, TICK, 0, 1, 1, 0, true];
    const client = makeClient(slot0, undefined, new Error('OLD'));
    await expect(fetchYieldBps(client, POOL, 'test')).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });

  it('throws ConciergeError(InsufficientLiquidity) when computed yield <= 0', async () => {
    const slot0 = [SQRT_PRICE, TICK, 0, 1, 1, 0, true];
    // meanTick < tick_now → positive deviation → negative yield (USDY depreciated)
    // tickCumulativeDiff must be < tick_now * SECONDS_7D for meanTick < tick_now
    const tickCumulativeNow = 23_000_000_000_000n;
    // Use diff = 275720 * 604800 = 166_737_216_000 (< 275725 * 604800 → meanTick < tick_now)
    const tickCumulativePast = tickCumulativeNow - 166_737_216_000n;
    const observeResult = [
      [tickCumulativeNow, tickCumulativePast],
      [0n, 0n],
    ];
    const client = makeClient(slot0, observeResult);
    await expect(fetchYieldBps(client, POOL, 'test')).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });
});
