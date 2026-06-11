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

export const AttestationPayloadSchema = z.object({
  schema: z.string(),
  chain: z.number(),
  venue: z.string(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: z.string(),
  amountOut: z.string(),
  slippageBps: z.number(),
  quotedOut: z.string(),
  txHash: z.string(),
  ts: z.number(),
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
  txHash: Hex;
}): AttestationPayload {
  const { venue, chainId, tokenIn, tokenOut, amountIn, amountOut, quotedOut, txHash } = params;
  const slippageBps = quotedOut > 0n ? Number(((quotedOut - amountOut) * 10_000n) / quotedOut) : 0;
  return {
    schema: ATTESTATION_SCHEMAS[venue],
    chain: chainId,
    venue,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    slippageBps,
    quotedOut: quotedOut.toString(),
    txHash,
    ts: Math.floor(Date.now() / 1000),
  };
}
