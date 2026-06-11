// Integration tests against a live Anvil fork of Mantle Mainnet.
// Requires Foundry (anvil) to be installed. Set ANVIL_BIN=/path/to/anvil if not on PATH.

import { ADDRESSES } from '@concierge/shared';
import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMantleDexProvider } from '../../provider.ts';
import { type AnvilFork, startAnvilFork } from '../setup.ts';

const USDC = ADDRESSES.mantleMainnet.tokens.USDC;
const sUSDe = ADDRESSES.mantleMainnet.tokens.sUSDe;
const USDC_AMOUNT = 100_000_000n; // 100 USDC (6 decimals)

// Single fork shared across all describe blocks in this file.
let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

function makeProvider() {
  const publicClient = createPublicClient({
    chain: fork.chain,
    transport: http(`http://127.0.0.1:${fork.port}`),
  });
  return createMantleDexProvider({ publicClient, chain: 'mantle-mainnet' });
}

describe('quote action (Mainnet fork integration)', () => {
  it('returns allRoutes with all 5 venue keys', async () => {
    const result = await makeProvider().actions.quote.invoke({
      tokenIn: USDC,
      tokenOut: sUSDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 50,
    });

    expect(result.allRoutes).toHaveProperty('merchantMoe');
    expect(result.allRoutes).toHaveProperty('agni');
    expect(result.allRoutes).toHaveProperty('fusionx');
    expect(result.allRoutes).toHaveProperty('woofi');
    expect(result.allRoutes).toHaveProperty('lifi');
  }, 60_000);

  it('bestAmountOut equals max of all successful venue amountOuts', async () => {
    const result = await makeProvider().actions.quote.invoke({
      tokenIn: USDC,
      tokenOut: sUSDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 50,
    });

    const successAmounts = Object.values(result.allRoutes)
      .filter((r): r is { amountOut: string } => r.amountOut !== null)
      .map((r) => BigInt(r.amountOut));

    expect(successAmounts.length).toBeGreaterThan(0);
    const maxAmountOut = successAmounts.reduce((m, v) => (v > m ? v : m), 0n);
    expect(BigInt(result.bestAmountOut)).toBe(maxAmountOut);
  }, 60_000);

  it('bestRoute corresponds to the venue with highest amountOut', async () => {
    const result = await makeProvider().actions.quote.invoke({
      tokenIn: USDC,
      tokenOut: sUSDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 50,
    });

    const bestVenueRoute = result.allRoutes[result.bestRoute];
    expect(bestVenueRoute.amountOut).not.toBeNull();
    expect(bestVenueRoute.amountOut).toBe(result.bestAmountOut);
  }, 60_000);

  it('venue with no route returns { amountOut: null, reason: "no_route" }', async () => {
    const result = await makeProvider().actions.quote.invoke({
      tokenIn: USDC,
      tokenOut: sUSDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 50,
    });

    // Any null-amountOut venue must carry reason:'no_route' (shape test).
    for (const [, route] of Object.entries(result.allRoutes)) {
      if (route.amountOut === null) {
        expect((route as { reason: string }).reason).toBe('no_route');
      }
    }
  }, 60_000);

  it('throws InsufficientLiquidity for a token pair with no routes on any venue', async () => {
    // This address is not an ERC-20 on Mantle — every venue will revert or return null.
    const NONEXISTENT = '0x1111111111111111111111111111111111111111' as typeof USDC;
    await expect(
      makeProvider().actions.quote.invoke({
        tokenIn: USDC,
        tokenOut: NONEXISTENT,
        amountIn: USDC_AMOUNT,
        slippageBps: 50,
      }),
    ).rejects.toMatchObject({ type: 'InsufficientLiquidity' });
  }, 60_000);
});

// WOOFi null-route behaviour is tested at the venue level in __tests__/venues/woofi.test.ts
// using a mocked publicClient that can deterministically simulate a revert without a fork.
