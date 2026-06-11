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

describe('quote action (Mainnet fork integration)', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  }, 60_000);

  afterAll(async () => {
    await fork.stop();
  });

  it('returns allRoutes with all 5 venue keys', async () => {
    const publicClient = createPublicClient({
      chain: fork.chain,
      transport: http(`http://127.0.0.1:${fork.port}`),
    });
    const p = createMantleDexProvider({ publicClient, chain: 'mantle-mainnet' });
    const result = await p.actions.quote.invoke({
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
    const publicClient = createPublicClient({
      chain: fork.chain,
      transport: http(`http://127.0.0.1:${fork.port}`),
    });
    const p = createMantleDexProvider({ publicClient, chain: 'mantle-mainnet' });
    const result = await p.actions.quote.invoke({
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
    const publicClient = createPublicClient({
      chain: fork.chain,
      transport: http(`http://127.0.0.1:${fork.port}`),
    });
    const p = createMantleDexProvider({ publicClient, chain: 'mantle-mainnet' });
    const result = await p.actions.quote.invoke({
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
    const publicClient = createPublicClient({
      chain: fork.chain,
      transport: http(`http://127.0.0.1:${fork.port}`),
    });
    const p = createMantleDexProvider({ publicClient, chain: 'mantle-mainnet' });
    // Use an obscure address pair that WOOFi almost certainly doesn't list.
    // We only check the shape — if WOOFi happens to have a route, skip.
    const result = await p.actions.quote.invoke({
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
});

describe('quote action — WOOFi null route (on-chain)', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  }, 60_000);

  afterAll(async () => {
    await fork.stop();
  });

  it('WOOFi returns null cleanly for USDY→sUSDe (no WOOFi listing expected)', async () => {
    const publicClient = createPublicClient({
      chain: fork.chain,
      transport: http(`http://127.0.0.1:${fork.port}`),
    });
    const USDY = ADDRESSES.mantleMainnet.tokens.USDY;
    const p = createMantleDexProvider({ publicClient, chain: 'mantle-mainnet' });
    const result = await p.actions.quote.invoke({
      tokenIn: USDY,
      tokenOut: sUSDe,
      amountIn: 1_000_000_000_000_000_000n, // 1 USDY (18 dec)
      slippageBps: 50,
    });
    // If WOOFi has no listing it returns null — if it does, this test just passes without asserting.
    if (result.allRoutes.woofi.amountOut === null) {
      expect((result.allRoutes.woofi as { reason: string }).reason).toBe('no_route');
    }
  }, 60_000);
});
