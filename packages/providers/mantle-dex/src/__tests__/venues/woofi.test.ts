// Unit tests for createWooFiVenue — no fork required; publicClient is mocked.

import type { Address } from '@concierge/shared';
import { ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createWooFiVenue } from '../../venues/woofi.ts';

const ROUTER = '0x1234000000000000000000000000000000000000' as Address;
const TOKEN_IN = '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as Address;
const TOKEN_OUT = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' as Address;

describe('createWooFiVenue — quote', () => {
  it('returns null when querySwap reverts (no listing)', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(
        new ContractFunctionRevertedError({
          abi: [],
          functionName: 'querySwap',
          message: 'no listing',
        }),
      ),
    };
    const venue = createWooFiVenue(publicClient as never, undefined, ROUTER);
    const result = await venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 1_000n });
    expect(result).toBeNull();
  });

  it('returns null when querySwap returns 0', async () => {
    const publicClient = { readContract: vi.fn().mockResolvedValue(0n) };
    const venue = createWooFiVenue(publicClient as never, undefined, ROUTER);
    const result = await venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 1_000n });
    expect(result).toBeNull();
  });

  it('returns VenueQuoteResult with amountOut when querySwap succeeds', async () => {
    const publicClient = { readContract: vi.fn().mockResolvedValue(999_000n) };
    const venue = createWooFiVenue(publicClient as never, undefined, ROUTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toMatchObject({ venue: 'woofi', amountOut: 999_000n });
  });

  it('returns null when viem wraps revert in ContractFunctionExecutionError (fork behaviour)', async () => {
    const inner = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'querySwap',
      message: 'no listing',
    });
    const outer = new ContractFunctionExecutionError(inner, {
      abi: [],
      functionName: 'querySwap',
    });
    const publicClient = { readContract: vi.fn().mockRejectedValue(outer) };
    const venue = createWooFiVenue(publicClient as never, undefined, ROUTER);
    const result = await venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 1_000n });
    expect(result).toBeNull();
  });

  it('propagates non-revert errors (RPC failure)', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const venue = createWooFiVenue(publicClient as never, undefined, ROUTER);
    await expect(
      venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 1_000n }),
    ).rejects.toThrow('network error');
  });
});
