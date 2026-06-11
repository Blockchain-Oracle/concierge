// Integration tests for getBalance — tests the full pipeline:
// ERC20 balanceOf + Agni slot0 for DEX price → compute usdValue + yieldAccrued.
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeGetBalance } from '../../actions/getBalance.ts';
import { type AnvilFork, KNOWN_USDY_HOLDER, startAnvilFork } from '../setup.ts';

const AGNI_USDY_USDC = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;
const USDY_BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;
// A valid non-zero address with no USDY balance.
const NO_USDY_ADDR = '0x0000000000000000000000000000000000000001' as const;

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

describe('getBalance — fork (real Mantle mainnet state)', () => {
  it('returns positive raw + usdValue > raw for a known USDY holder', async () => {
    const ctx = { publicClient: fork.publicClient, chainId: 5000 as const, addresses };
    const result = await executeGetBalance(ctx, KNOWN_USDY_HOLDER);

    const raw = BigInt(result.raw);
    const usdValue = BigInt(result.usdValue);
    const yieldAccrued = BigInt(result.yieldAccrued);

    expect(raw).toBeGreaterThan(0n);
    expect(usdValue).toBeGreaterThan(raw); // USDY should be > $1.00
    expect(yieldAccrued).toBeGreaterThan(0n); // yield accrued = usdValue - raw
    expect(yieldAccrued).toBe(usdValue - raw);
    expect(result.attestationPayload.schema).toBe('concierge.ondo.read.v1');
  }, 30_000);

  it('returns zero raw + usdValue for an address with no USDY', async () => {
    const ctx = { publicClient: fork.publicClient, chainId: 5000 as const, addresses };
    const result = await executeGetBalance(ctx, NO_USDY_ADDR);

    expect(BigInt(result.raw)).toBe(0n);
    expect(BigInt(result.usdValue)).toBe(0n);
    expect(BigInt(result.yieldAccrued)).toBe(0n);
  }, 30_000);
});

describe('getBalance — error paths (mocked)', () => {
  it('throws ConciergeError(RpcError) when balanceOf reverts', async () => {
    const SQRT_PRICE = 76893643322421959054268744908233200n;
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return Promise.reject(new Error('revert'));
        if (functionName === 'slot0')
          return Promise.resolve([SQRT_PRICE, 275725, 0, 1, 1, 0, true]);
        return Promise.reject(new Error(`Unexpected: ${functionName}`));
      }),
      getBlockNumber: vi.fn().mockResolvedValue(12345n),
    };
    const ctx = { publicClient, chainId: 5000 as const, addresses };
    await expect(executeGetBalance(ctx, KNOWN_USDY_HOLDER)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && (e as ConciergeError).type === 'RpcError',
    );
  });

  it('throws ConciergeError(RpcError) when pool slot0 reverts', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return Promise.resolve(1_000_000_000_000_000_000n);
        if (functionName === 'slot0') return Promise.reject(new Error('slot0 revert'));
        return Promise.reject(new Error(`Unexpected: ${functionName}`));
      }),
      getBlockNumber: vi.fn().mockResolvedValue(12345n),
    };
    const ctx = { publicClient, chainId: 5000 as const, addresses };
    await expect(executeGetBalance(ctx, KNOWN_USDY_HOLDER)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && (e as ConciergeError).type === 'RpcError',
    );
  });
});

describe('getBalance — happy path (mocked DEX)', () => {
  it('computes usdValue and yieldAccrued correctly from mocked pool and balance', async () => {
    const RAW = 1_000_000_000_000_000_000n; // 1 USDY
    // sqrtPriceX96 for ~$1.0617 USDY price
    const SQRT_PRICE = 76893643322421959054268744908233200n;
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    const publicClient: any = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return Promise.resolve(RAW);
        if (functionName === 'slot0')
          return Promise.resolve([SQRT_PRICE, 275725, 0, 1, 1, 0, true]);
        return Promise.reject(new Error(`Unexpected: ${functionName}`));
      }),
      getBlockNumber: vi.fn().mockResolvedValue(12345n),
    };
    const ctx = { publicClient, chainId: 5000 as const, addresses };
    const result = await executeGetBalance(ctx, KNOWN_USDY_HOLDER);

    const usdValue = BigInt(result.usdValue);
    expect(usdValue).toBeGreaterThan(RAW); // USDY > $1.00
    expect(BigInt(result.yieldAccrued)).toBe(usdValue - RAW);
    expect(result.attestationPayload.schema).toBe('concierge.ondo.read.v1');
  });
});
