// Unit tests for createAgniVenue — focuses on stable-pair fee ordering without a fork.

import type { Address } from '@concierge/shared';
import { ContractFunctionRevertedError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createAgniVenue } from '../../venues/agni.ts';

const SWAP_ROUTER = '0x1234000000000000000000000000000000000000' as Address;
const QUOTER = '0x5678000000000000000000000000000000000000' as Address;

// USDC and USDe — both stable tokens
const USDC = '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as Address;
const USDe = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' as Address;

// Non-stable token
const WMNT = '0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8' as Address;

describe('createAgniVenue — quote fee ordering', () => {
  it('for a stable pair, queries 100bps tier first (most likely to have liquidity)', async () => {
    const feeOrder: number[] = [];
    const publicClient = {
      readContract: vi.fn().mockImplementation(({ args }: { args: [{ fee: number }] }) => {
        feeOrder.push(args[0].fee);
        // Only the 100bps tier returns a non-null result
        if (args[0].fee === 100) return Promise.resolve([1_000_000n, 0n, 0, 0n]);
        return Promise.resolve([0n, 0n, 0, 0n]);
      }),
    };
    const venue = createAgniVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    await venue.quote({ tokenIn: USDC, tokenOut: USDe, amountIn: 1_000_000n });
    // Stable pair: first fee tried should be 100 (lowest)
    expect(feeOrder[0]).toBe(100);
  });

  it('for a non-stable pair, queries 3000bps tier first', async () => {
    const feeOrder: number[] = [];
    const publicClient = {
      readContract: vi.fn().mockImplementation(({ args }: { args: [{ fee: number }] }) => {
        feeOrder.push(args[0].fee);
        return Promise.resolve([0n, 0n, 0, 0n]);
      }),
    };
    const venue = createAgniVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    await venue.quote({ tokenIn: USDC, tokenOut: WMNT, amountIn: 1_000_000n });
    // Non-stable pair: first fee tried should be 3000
    expect(feeOrder[0]).toBe(3000);
  });

  it('returns null when all fee tiers revert', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(
        new ContractFunctionRevertedError({
          abi: [],
          functionName: 'quoteExactInputSingle',
          message: 'no pool',
          args: [],
        }),
      ),
    };
    const venue = createAgniVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    const result = await venue.quote({ tokenIn: USDC, tokenOut: WMNT, amountIn: 1_000_000n });
    expect(result).toBeNull();
  });

  it('picks the fee tier with highest amountOut', async () => {
    const publicClient = {
      readContract: vi.fn().mockImplementation(({ args }: { args: [{ fee: number }] }) => {
        const fee = args[0].fee;
        if (fee === 500) return Promise.resolve([1_200_000n, 0n, 0, 0n]);
        if (fee === 3000) return Promise.resolve([1_000_000n, 0n, 0, 0n]);
        return Promise.resolve([0n, 0n, 0, 0n]);
      }),
    };
    const venue = createAgniVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    const result = await venue.quote({ tokenIn: USDC, tokenOut: WMNT, amountIn: 1_000_000n });
    expect(result?.amountOut).toBe(1_200_000n);
  });
});
