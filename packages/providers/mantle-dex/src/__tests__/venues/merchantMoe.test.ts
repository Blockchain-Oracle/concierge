// Unit tests for createMerchantMoeVenue — publicClient is mocked, no fork required.
import type { Address } from '@concierge/shared';
import { ContractFunctionExecutionError, ContractFunctionRevertedError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createMerchantMoeVenue } from '../../venues/merchantMoe.ts';

const LB_ROUTER = '0x1234000000000000000000000000000000000000' as Address;
const LB_QUOTER = '0x5678000000000000000000000000000000000000' as Address;
const TOKEN_IN = '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as Address;
const TOKEN_OUT = '0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8' as Address;

function makeQuoteResult(amounts: bigint[]) {
  return {
    route: [TOKEN_IN, TOKEN_OUT],
    pairs: ['0xpair' as Address],
    binSteps: [25n],
    versions: [3],
    amounts,
    virtualAmountsWithoutSlippage: amounts,
    fees: [3000000000000000n],
  };
}

describe('createMerchantMoeVenue — quote', () => {
  it('returns VenueQuoteResult when findBestPath returns valid amounts', async () => {
    const publicClient = {
      readContract: vi
        .fn()
        .mockResolvedValue(makeQuoteResult([100_000_000n, 123_000_000_000_000_000_000n])),
    };
    const venue = createMerchantMoeVenue(publicClient as never, undefined, LB_ROUTER, LB_QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100_000_000n,
    });
    expect(result).toMatchObject({ venue: 'merchantMoe', amountOut: 123_000_000_000_000_000_000n });
  });

  it('returns null when amounts array has fewer than 2 elements', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(makeQuoteResult([100_000_000n])),
    };
    const venue = createMerchantMoeVenue(publicClient as never, undefined, LB_ROUTER, LB_QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when last amount is 0', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(makeQuoteResult([100_000_000n, 0n])),
    };
    const venue = createMerchantMoeVenue(publicClient as never, undefined, LB_ROUTER, LB_QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when findBestPath reverts (no route for pair)', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(
        new ContractFunctionRevertedError({
          abi: [],
          functionName: 'findBestPathFromAmountIn',
          message: 'LBQuoter_RouteNotFound',
        }),
      ),
    };
    const venue = createMerchantMoeVenue(publicClient as never, undefined, LB_ROUTER, LB_QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when viem wraps revert in ContractFunctionExecutionError (fork behaviour)', async () => {
    // viem's readContract throws ContractFunctionExecutionError which wraps the inner revert.
    const inner = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'findBestPathFromAmountIn',
      message: 'LBQuoter_RouteNotFound',
    });
    const outer = new ContractFunctionExecutionError(inner, {
      abi: [],
      functionName: 'findBestPathFromAmountIn',
    });
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(outer),
    };
    const venue = createMerchantMoeVenue(publicClient as never, undefined, LB_ROUTER, LB_QUOTER);
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 100_000_000n,
    });
    expect(result).toBeNull();
  });

  it('propagates non-revert errors (RPC failure)', async () => {
    const publicClient = {
      readContract: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const venue = createMerchantMoeVenue(publicClient as never, undefined, LB_ROUTER, LB_QUOTER);
    await expect(
      venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 100_000_000n }),
    ).rejects.toThrow('network error');
  });
});
