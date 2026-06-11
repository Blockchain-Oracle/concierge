import type { Address, EvmChainId, Hex } from '@concierge/shared';
import { z } from 'zod';
import type { VenueName } from './_types.ts';

// Schema names per venue — verified by the shell check in story-32.
export const ATTESTATION_SCHEMAS = {
  merchantMoe: 'concierge.mantle-dex.merchantMoe.swap.v1',
  agni: 'concierge.mantle-dex.agni.swap.v1',
  fusionx: 'concierge.mantle-dex.fusionx.swap.v1',
  woofi: 'concierge.mantle-dex.woofi.swap.v1',
  lifi: 'concierge.mantle-dex.lifi.swap.v1',
} as const satisfies Record<VenueName, string>;

const ATTESTATION_SCHEMA_VALUES = Object.values(ATTESTATION_SCHEMAS) as [string, ...string[]];

export const AttestationPayloadSchema = z.object({
  schema: z.enum(ATTESTATION_SCHEMA_VALUES),
  chain: z.number().int().positive(),
  venue: z.enum(['merchantMoe', 'agni', 'fusionx', 'woofi', 'lifi']),
  tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountIn: z.string().regex(/^\d+$/),
  amountOut: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(0).max(10000),
  quotedOut: z.string().regex(/^\d+$/),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  ts: z.number().int().positive(),
});

export type AttestationPayload = z.infer<typeof AttestationPayloadSchema>;

export function buildAttestationPayload(params: {
  venue: VenueName;
  chainId: EvmChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  quotedOut: bigint;
  // The configured slippage tolerance from the user's args — not realized slippage.
  // Realized delta can be negative (price improvement) which breaks schema min(0).
  slippageBps: number;
  txHash: Hex;
}): AttestationPayload {
  const { venue, chainId, tokenIn, tokenOut, amountIn, amountOut, quotedOut, slippageBps, txHash } =
    params;
  const payload = {
    schema: ATTESTATION_SCHEMAS[venue],
    chain: chainId,
    venue,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    slippageBps: Math.max(0, Math.min(10_000, slippageBps)),
    quotedOut: quotedOut.toString(),
    txHash,
    ts: Math.floor(Date.now() / 1000),
  };
  return AttestationPayloadSchema.parse(payload);
}
