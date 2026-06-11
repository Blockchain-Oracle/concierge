import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import { type ActionContext, ROUTE_TTL_MS } from '../_context.ts';
import { type LifiBridgeRoute, LifiBridgeRouteSchema } from '../_types.ts';
import {
  buildSentAttestation,
  type SentAttestationPayload,
  SentAttestationPayloadSchema,
} from '../attestation.ts';
import { executeQuote } from './quote.ts';

const NON_ZERO_ADDR = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((v) => v !== '0x0000000000000000000000000000000000000000')
  .transform((v) => v as `0x${string}`);

export const BridgeInput = z.object({
  fromChain: z.number().int().positive().describe('Source chain ID'),
  toChain: z.number().int().positive().describe('Destination chain ID'),
  fromToken: NON_ZERO_ADDR.describe('Source token address'),
  toToken: NON_ZERO_ADDR.describe('Destination token address'),
  amount: z.string().regex(/^\d+$/).describe('Amount in base units'),
  slippageBps: z.number().int().min(1).max(5000).default(50).describe('Max slippage in bps'),
  fromAddress: NON_ZERO_ADDR.describe('Sender wallet address'),
  toAddress: NON_ZERO_ADDR.optional().describe('Recipient address (defaults to fromAddress)'),
  route: LifiBridgeRouteSchema.optional().describe('Pre-fetched route; re-quoted if stale (>30s)'),
});

export const BridgeOutput = z.object({
  sourceTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('Transaction hash on the source chain'),
  lifiOperationId: z
    .string()
    .describe('Li.Fi operation ID for status polling and completed attestation'),
  expectedDuration: z.number().int().nonnegative().describe('Estimated completion time in seconds'),
  attestationPayload: SentAttestationPayloadSchema.describe(
    'ERC-8004 sent attestation — record immediately',
  ),
});

async function requireWallet(ctx: ActionContext) {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/lifi-bridge] bridge: walletClient is required. Pass walletClient when creating the provider.',
    );
  }
  const account = ctx.walletClient.account?.address as `0x${string}` | undefined;
  if (!account) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/lifi-bridge] bridge: walletClient has no bound account. Use createWalletClient({ account }).',
    );
  }
  return { walletClient: ctx.walletClient, account };
}

async function resolveRoute(
  ctx: ActionContext,
  input: z.infer<typeof BridgeInput>,
): Promise<LifiBridgeRoute> {
  if (input.route && Date.now() - input.route._receivedAt <= ROUTE_TTL_MS) return input.route;
  const quoteResult = await executeQuote(ctx, {
    fromChain: input.fromChain,
    toChain: input.toChain,
    fromToken: input.fromToken as string,
    toToken: input.toToken as string,
    amount: input.amount,
    slippageBps: input.slippageBps,
    fromAddress: input.fromAddress as string,
    toAddress: input.toAddress ? (input.toAddress as string) : undefined,
  });
  if (!quoteResult.route) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      '[@concierge/lifi-bridge] bridge: no routes available for this token pair',
    );
  }
  return quoteResult.route;
}

async function submitBridgeTx(
  walletClient: NonNullable<ActionContext['walletClient']>,
  txReq: LifiBridgeRoute['transactionRequest'],
): Promise<`0x${string}`> {
  if (walletClient.chain !== undefined && walletClient.chain.id !== txReq.chainId) {
    throw new ConciergeError(
      'NetworkUnsupported',
      `[@concierge/lifi-bridge] bridge: wallet chain ${walletClient.chain.id} ≠ route chain ${txReq.chainId} — switch networks before bridging`,
    );
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: sendTransaction overloads vary by account/chain binding
    return await (walletClient as any).sendTransaction({
      to: txReq.to as `0x${string}`,
      data: txReq.data as `0x${string}`,
      value: BigInt(txReq.value || '0'),
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      '[@concierge/lifi-bridge] bridge: source-chain tx submission failed',
      err instanceof Error ? err : undefined,
    );
  }
}

export async function executeBridge(
  ctx: ActionContext,
  input: z.infer<typeof BridgeInput>,
): Promise<z.infer<typeof BridgeOutput>> {
  const { walletClient } = await requireWallet(ctx);
  const route = await resolveRoute(ctx, input);
  const sourceTxHash = await submitBridgeTx(walletClient, route.transactionRequest);
  const lifiOperationId = route.id;
  const expectedDuration = route.estimate.executionDuration;

  let attestationPayload: SentAttestationPayload;
  try {
    attestationPayload = buildSentAttestation({
      fromChain: route.fromChainId,
      toChain: route.toChainId,
      sourceTxHash,
      lifiOperationId,
      fromToken: route.fromToken.address,
      toToken: route.toToken.address,
      amountIn: route.estimate.fromAmount,
      expectedAmountOut: route.estimate.toAmountMin,
      expectedDuration,
    });
  } catch (err) {
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/lifi-bridge] bridge: tx submitted (sourceTxHash: ${sourceTxHash}) but attestation failed — record tx manually`,
      err instanceof Error ? err : undefined,
    );
  }

  return { sourceTxHash, lifiOperationId, expectedDuration, attestationPayload };
}

export function createBridgeTool(ctx: ActionContext) {
  return tool({
    name: 'bridge',
    description:
      'Submits a cross-chain bridge transaction via Li.Fi. Re-quotes if the provided route is stale (>30s). ' +
      'Returns immediately after source-chain submission with a `concierge.lifi.bridge.sent.v1` attestation. ' +
      'Use getStatus to poll for destination-chain settlement, then record a `completed` attestation.',
    inputSchema: BridgeInput,
    outputSchema: BridgeOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeBridge(ctx, input),
  });
}
