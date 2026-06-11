// Integration tests for getRateAccrual — tests DEX spot price → multiplier pipeline.

import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeGetRateAccrual } from '../../actions/getRateAccrual.ts';
import { type AnvilFork, startAnvilFork } from '../setup.ts';

const AGNI_USDY_USDC = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;
const USDY_BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

const addresses = {
  usdy: ADDRESSES.mantleMainnet.tokens.USDY,
  agniUsdyUsdc: AGNI_USDY_USDC,
  usdyBlocklist: USDY_BLOCKLIST,
};

describe('getRateAccrual — fork (real Mantle mainnet state)', () => {
  it('returns multiplier > 1e18 (USDY is worth more than $1.00)', async () => {
    const ctx = { publicClient: fork.publicClient, chainId: 5000 as const, addresses };
    const result = await executeGetRateAccrual(ctx);

    const multiplier = BigInt(result.multiplier);
    expect(multiplier).toBeGreaterThan(1_000_000_000_000_000_000n); // > $1.00
    expect(result.rateMantissa).toBe('0'); // no on-chain accrual rate for Mantle USDY
    expect(Number(result.lastUpdateBlock)).toBeGreaterThan(0);
  }, 30_000);
});

describe('getRateAccrual — error paths (mocked)', () => {
  it('throws ConciergeError(RpcError) when pool slot0 reverts', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockRejectedValue(new Error('slot0 revert')),
      getBlockNumber: vi.fn().mockResolvedValue(99999n),
    };
    const ctx = { publicClient, chainId: 5000 as const, addresses };
    await expect(executeGetRateAccrual(ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && (e as ConciergeError).type === 'RpcError',
    );
  });
});

describe('getRateAccrual — happy path (mocked DEX)', () => {
  it('returns correct multiplier from sqrtPriceX96', async () => {
    const SQRT_PRICE = 76893643322421959054268744908233200n;
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockResolvedValue([SQRT_PRICE, 275725, 0, 1, 1, 0, true]),
      getBlockNumber: vi.fn().mockResolvedValue(99999n),
    };
    const ctx = { publicClient, chainId: 5000 as const, addresses };
    const result = await executeGetRateAccrual(ctx);

    const multiplier = BigInt(result.multiplier);
    expect(multiplier).toBeGreaterThan(1_060_000_000_000_000_000n);
    expect(multiplier).toBeLessThan(1_080_000_000_000_000_000n);
    expect(result.rateMantissa).toBe('0');
    expect(result.lastUpdateBlock).toBe('99999');
  });
});
