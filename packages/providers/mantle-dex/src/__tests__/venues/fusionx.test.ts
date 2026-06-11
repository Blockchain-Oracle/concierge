// Unit tests for createFusionXVenue — publicClient is mocked, no fork required.
import type { Address } from '@concierge/shared';
import { ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createFusionXVenue } from '../../venues/fusionx.ts';

const SWAP_ROUTER = '0x1234000000000000000000000000000000000000' as Address;
const QUOTER = '0x5678000000000000000000000000000000000000' as Address;
const TOKEN_IN = '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as Address;
const TOKEN_OUT = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' as Address;

describe('createFusionXVenue — quote', () => {
  it('returns VenueQuoteResult when quoter succeeds', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([999_000n, 100, 0, 5000n]),
    };
    const venue = createFusionXVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toMatchObject({ venue: 'fusionx', amountOut: 999_000n });
  });

  it('returns null when quoter returns 0 amountOut', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue([0n, 0, 0, 0n]),
    };
    const venue = createFusionXVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when quoter reverts (no pool for pair)', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(
        new ContractFunctionRevertedError({
          abi: [],
          functionName: 'quoteExactInputSingle',
          message: 'no pool',
        }),
      ),
    };
    const venue = createFusionXVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when viem wraps revert in ContractFunctionExecutionError (fork behaviour)', async () => {
    // viem's readContract throws ContractFunctionExecutionError which wraps the inner revert.
    const inner = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'quoteExactInputSingle',
      message: 'no pool',
    });
    const outer = new ContractFunctionExecutionError(inner, {
      abi: [],
      functionName: 'quoteExactInputSingle',
    });
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(outer),
    };
    const venue = createFusionXVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('propagates non-revert errors', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    const venue = createFusionXVenue(publicClient as never, undefined, SWAP_ROUTER, QUOTER);
    await expect(
      venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 1_000_000n }),
    ).rejects.toThrow('connection refused');
  });
});
