// Integration tests for getRateAccrual — tests DEX spot price → multiplier pipeline.

import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeGetRateAccrual } from '../../actions/getRateAccrual.ts';
import { type AnvilFork, startAnvilFork } from '../setup.ts';

const AGNI_USDY_USDC = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;
const USDY_BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;

let fork: AnvilFork;
let forkCtx: ActionContext;

const addresses = {
  usdy: ADDRESSES.mantleMainnet.tokens.USDY,
  agniUsdyUsdc: AGNI_USDY_USDC,
  usdyBlocklist: USDY_BLOCKLIST,
};

beforeAll(async () => {
  fork = await startAnvilFork();
  forkCtx = { publicClient: fork.publicClient, chainId: 5000, addresses };
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

describe('getRateAccrual — fork (real Mantle mainnet state)', () => {
  it('returns multiplier > 1e18 (USDY is worth more than $1.00)', async () => {
    const result = await executeGetRateAccrual(forkCtx);

    const multiplier = BigInt(result.multiplier);
    expect(multiplier).toBeGreaterThan(1_000_000_000_000_000_000n); // > $1.00
    expect(result.rateMantissa).toBe('0'); // no on-chain accrual rate for Mantle USDY
    expect(Number(result.lastUpdateBlock)).toBeGreaterThan(0);
  }, 30_000);

  it('returns deterministic results on the same fork state (idempotency)', async () => {
    // Pure read over fixed fork state — identical pool state, identical result.
    // Catches any non-determinism (e.g. timestamp-dependent logic, randomness bugs).
    const [result1, result2] = await Promise.all([
      executeGetRateAccrual(forkCtx),
      executeGetRateAccrual(forkCtx),
    ]);
    expect(result2.multiplier).toBe(result1.multiplier);
    expect(result2.rateMantissa).toBe(result1.rateMantissa);
  }, 30_000);
});

describe('getRateAccrual — error paths (mocked)', () => {
  it('throws ConciergeError(RpcError) when pool slot0 reverts', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockRejectedValue(new Error('slot0 revert')),
      getBlockNumber: vi.fn().mockResolvedValue(99999n),
    };
    const ctx: ActionContext = { publicClient, chainId: 5000, addresses };
    await expect(executeGetRateAccrual(ctx)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && (e as ConciergeError).type === 'RpcError',
    );
  });
});

describe('getRateAccrual — monotonic invariant (mocked)', () => {
  it('multiplier(N+1000) >= multiplier(N) when USDY appreciates (monotonicity guard)', async () => {
    // Smaller sqrtPriceX96 → higher computed price (USDY is more expensive per USDC).
    // SQRT_PAST > SQRT_NOW models real USDY appreciation across blocks: past sqrtPrice was
    // higher (token was cheaper), current sqrtPrice is lower (token is more expensive now).
    const SQRT_PAST = 77_000_000_000_000_000_000_000_000_000_000_000n; // block N: ~$1.053
    const SQRT_NOW = 76_893_643_322_421_959_054_268_744_908_233_200n; // block N+1000: ~$1.062

    function makeClient(sqrtPriceX96: bigint, blockN: bigint) {
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      const client: any = {
        readContract: vi.fn().mockResolvedValue([sqrtPriceX96, 275725, 0, 1, 1, 0, true]),
        getBlockNumber: vi.fn().mockResolvedValue(blockN),
      };
      return client;
    }

    const ctxN: ActionContext = {
      publicClient: makeClient(SQRT_PAST, 96_500_000n),
      chainId: 5000,
      addresses,
    };
    const ctxN1000: ActionContext = {
      publicClient: makeClient(SQRT_NOW, 96_501_000n),
      chainId: 5000,
      addresses,
    };

    const resultN = await executeGetRateAccrual(ctxN);
    const resultN1000 = await executeGetRateAccrual(ctxN1000);

    expect(BigInt(resultN1000.multiplier)).toBeGreaterThan(BigInt(resultN.multiplier));
    expect(Number(resultN1000.lastUpdateBlock)).toBeGreaterThan(Number(resultN.lastUpdateBlock));
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
    const ctx: ActionContext = { publicClient, chainId: 5000, addresses };
    const result = await executeGetRateAccrual(ctx);

    const multiplier = BigInt(result.multiplier);
    expect(multiplier).toBeGreaterThan(1_060_000_000_000_000_000n);
    expect(multiplier).toBeLessThan(1_080_000_000_000_000_000n);
    expect(result.rateMantissa).toBe('0');
    expect(result.lastUpdateBlock).toBe('99999');
  });
});
