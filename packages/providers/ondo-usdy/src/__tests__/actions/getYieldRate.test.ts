// Integration tests for getYieldRate — tests 7-day TWAP yield computation.
// Fork note: Pinned to FORK_BLOCK (block 96_500_000 ≈ 2026-06-10).
// At that block the Agni USDY/USDC pool (deployed ~2026-06-05) is ~5 days old,
// so observe([604800]) reverts with "OLD" — deterministically verifying InsufficientLiquidity.
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeGetYieldRate } from '../../actions/getYieldRate.ts';
import { type AnvilFork, FORK_BLOCK, startAnvilFork } from '../setup.ts';

const AGNI_USDY_USDC = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;
const USDY_BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork(FORK_BLOCK);
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

const addresses = {
  usdy: ADDRESSES.mantleMainnet.tokens.USDY,
  agniUsdyUsdc: AGNI_USDY_USDC,
  usdyBlocklist: USDY_BLOCKLIST,
};

describe('getYieldRate — fork (real Mantle mainnet)', () => {
  it('throws InsufficientLiquidity when Agni pool lacks 7-day TWAP history', async () => {
    const ctx = { publicClient: fork.publicClient, chainId: 5000 as const, addresses };
    await expect(executeGetYieldRate(ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  }, 30_000);
});

describe('getYieldRate — happy path (mocked 7-day TWAP with sufficient history)', () => {
  it('returns ~500 bps for synthetic TWAP data representing 5% APY', async () => {
    const TICK = 275725;
    const SQRT_PRICE = 76893643322421959054268744908233200n;
    // Tick cumulatives computed for ~500 bps APY (tick decreasing = USDY appreciating):
    // tickDeviation = -4.795 → meanTick = 275729.795
    // tickCumulativeDiff = 275729.795 * 604800 ≈ 166_761_500_000
    const TICK_CUMULATIVE_NOW = 23_000_000_000_000n;
    const TICK_CUMULATIVE_7D = TICK_CUMULATIVE_NOW - 166_761_500_000n;
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'slot0') return Promise.resolve([SQRT_PRICE, TICK, 0, 1, 1, 0, true]);
        if (functionName === 'observe')
          return Promise.resolve([
            [TICK_CUMULATIVE_NOW, TICK_CUMULATIVE_7D],
            [0n, 0n],
          ]);
        return Promise.reject(new Error(`Unexpected: ${functionName}`));
      }),
    };
    const ctx = { publicClient, chainId: 5000 as const, addresses };
    const result = await executeGetYieldRate(ctx);
    expect(result.yieldBps).toBeGreaterThanOrEqual(450);
    expect(result.yieldBps).toBeLessThanOrEqual(550);
  });
});
