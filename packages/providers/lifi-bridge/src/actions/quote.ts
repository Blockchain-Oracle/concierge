import { tool } from '@concierge/tools';
import { z } from 'zod';
import { fetchQuote, type GetQuoteParams } from '../_api.ts';
import type { ActionContext } from '../_context.ts';
import { LifiBridgeRouteSchema } from '../_types.ts';

const NON_ZERO_ADDR = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((v) => v !== '0x0000000000000000000000000000000000000000');

export const QuoteInput = z.object({
  fromChain: z.number().int().positive().describe('Source chain ID'),
  toChain: z.number().int().positive().describe('Destination chain ID'),
  fromToken: NON_ZERO_ADDR.describe('Source token contract address'),
  toToken: NON_ZERO_ADDR.describe('Destination token contract address'),
  amount: z
    .string()
    .regex(/^\d+$/)
    .describe('Amount to bridge in base units (e.g., wei for 18-decimal tokens)'),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(50)
    .describe('Max slippage in bps (default 50 = 0.5%)'),
  fromAddress: NON_ZERO_ADDR.describe('Sender wallet address'),
  toAddress: NON_ZERO_ADDR.optional().describe(
    'Recipient on destination chain (defaults to fromAddress)',
  ),
  excludeBridges: z
    .array(z.string())
    .optional()
    .describe('Bridge names to exclude (e.g., ["connext"])'),
});

export const QuoteOutput = z.object({
  route: LifiBridgeRouteSchema.nullable().describe(
    'Best available bridge route, or null if none found for this token pair',
  ),
  estimatedDuration: z
    .number()
    .int()
    .nonnegative()
    .describe('Estimated bridge completion time in seconds (0 if no route)'),
  bridges: z.array(z.string()).describe('Bridge protocol names in the route'),
});

export async function executeQuote(
  ctx: ActionContext,
  input: z.infer<typeof QuoteInput>,
): Promise<z.infer<typeof QuoteOutput>> {
  const params: GetQuoteParams = {
    fromChainId: input.fromChain,
    toChainId: input.toChain,
    fromTokenAddress: input.fromToken,
    toTokenAddress: input.toToken,
    fromAmount: input.amount,
    fromAddress: input.fromAddress,
    toAddress: input.toAddress ?? input.fromAddress,
    slippage: input.slippageBps / 10_000,
    integrator: ctx.integrator,
    apiKey: ctx.apiKey,
    denyBridges: input.excludeBridges,
  };

  const route = await fetchQuote(params);
  const estimatedDuration = route?.estimate.executionDuration ?? 0;
  const bridges = route ? [route.toolDetails.name] : [];

  return { route, estimatedDuration, bridges };
}

export function createQuoteTool(ctx: ActionContext) {
  return tool({
    name: 'quote',
    description:
      'Returns the best available bridge route for a cross-chain asset transfer via Li.Fi. ' +
      'Covers Mantle ↔ Ethereum / Base / Arbitrum / Polygon / Optimism. ' +
      'Pure read — no transaction. Route expires after 30 seconds.',
    inputSchema: QuoteInput,
    outputSchema: QuoteOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeQuote(ctx, input),
  });
}
