import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { NON_ZERO_ADDRESS, VENUE_NAME } from '../_schema.ts';
import type { Venue, VenueName, VenueQuoteResult } from '../_types.ts';
import { createAgniVenue } from '../venues/agni.ts';
import { createFusionXVenue } from '../venues/fusionx.ts';
import { createLifiVenue } from '../venues/lifi.ts';
import { createMerchantMoeVenue } from '../venues/merchantMoe.ts';
import { createWooFiVenue } from '../venues/woofi.ts';

export const QuoteInput = z.object({
  tokenIn: NON_ZERO_ADDRESS.describe('ERC-20 token to sell'),
  tokenOut: NON_ZERO_ADDRESS.describe('ERC-20 token to receive'),
  amountIn: z.coerce.bigint().positive().describe('Amount of tokenIn in base units'),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(50)
    .describe('Max slippage in bps (default 50 = 0.5%)'),
  account: NON_ZERO_ADDRESS.optional().describe('Sender address (improves Li.Fi quote accuracy)'),
});

const RouteResult = z.union([
  z.object({
    amountOut: z.string(),
    gasEstimate: z.string().optional(),
    approvalAddress: z.string().optional(),
  }),
  z.object({ amountOut: z.null(), reason: z.literal('no_route') }),
]);

export const QuoteOutput = z.object({
  bestRoute: VENUE_NAME,
  bestAmountOut: z.string().describe('Best amountOut in base units (decimal string)'),
  allRoutes: z.object({
    merchantMoe: RouteResult,
    agni: RouteResult,
    fusionx: RouteResult,
    woofi: RouteResult,
    lifi: RouteResult,
  }),
});

export type QuoteOutputType = z.infer<typeof QuoteOutput>;

function buildVenues(ctx: ActionContext): Venue[] {
  const { publicClient, walletClient, chainId, addresses } = ctx;
  return [
    createMerchantMoeVenue(
      publicClient,
      walletClient,
      addresses.merchantMoe.lbRouter,
      addresses.merchantMoe.lbQuoter,
    ),
    createAgniVenue(publicClient, walletClient, addresses.agni.swapRouter, addresses.agni.quoterV2),
    createFusionXVenue(
      publicClient,
      walletClient,
      addresses.fusionx.swapRouter,
      addresses.fusionx.quoterV2,
    ),
    createWooFiVenue(publicClient, walletClient, addresses.woofi.router),
    createLifiVenue(chainId, publicClient, walletClient, addresses.lifi.diamond),
  ];
}

export async function executeQuote(
  ctx: ActionContext,
  args: z.infer<typeof QuoteInput>,
): Promise<QuoteOutputType> {
  const { tokenIn, tokenOut, amountIn, account, slippageBps } = args;
  const venues = buildVenues(ctx);

  const baseParams = { tokenIn, tokenOut, amountIn, slippageBps };
  const quoteParams = account !== undefined ? { ...baseParams, account } : baseParams;
  const settled = await Promise.allSettled(venues.map((v) => v.quote(quoteParams)));

  const routeMap: Record<VenueName, VenueQuoteResult | null> = {
    merchantMoe: null,
    agni: null,
    fusionx: null,
    woofi: null,
    lifi: null,
  };

  settled.forEach((s, i) => {
    const venue = venues[i]?.name;
    if (!venue) return;
    if (s.status === 'rejected') {
      console.error(`[@concierge/mantle-dex] quote: ${venue} rejected:`, s.reason);
    } else if (s.value !== null) {
      routeMap[venue] = s.value;
    }
  });

  const validRoutes = (Object.values(routeMap) as (VenueQuoteResult | null)[])
    .filter((r): r is VenueQuoteResult => r !== null)
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));
  const best = validRoutes[0];

  if (best === undefined) {
    const { ConciergeError } = await import('@concierge/sdk');
    throw new ConciergeError(
      'InsufficientLiquidity',
      `[@concierge/mantle-dex] quote: no venue returned a route for ${tokenIn} → ${tokenOut}`,
    );
  }

  function toRouteEntry(r: VenueQuoteResult | null) {
    if (r === null) return { amountOut: null as null, reason: 'no_route' as const };
    return {
      amountOut: r.amountOut.toString(),
      ...(r.gasEstimate !== undefined && { gasEstimate: r.gasEstimate.toString() }),
      ...(r.approvalAddress !== undefined && { approvalAddress: r.approvalAddress }),
    };
  }

  const allRoutes = {
    merchantMoe: toRouteEntry(routeMap.merchantMoe),
    agni: toRouteEntry(routeMap.agni),
    fusionx: toRouteEntry(routeMap.fusionx),
    woofi: toRouteEntry(routeMap.woofi),
    lifi: toRouteEntry(routeMap.lifi),
  };

  return {
    bestRoute: best.venue,
    bestAmountOut: best.amountOut.toString(),
    allRoutes,
  };
}

export function createQuoteTool(ctx: ActionContext) {
  return tool({
    name: 'quote',
    description:
      'Get the best DEX quote across Merchant Moe, Agni, FusionX, WOOFi, and Li.Fi on Mantle. ' +
      'Returns amountOut per venue and identifies the best route. Pure read — no transaction.',
    inputSchema: QuoteInput,
    outputSchema: QuoteOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeQuote(ctx, args),
  });
}

export { buildVenues };
