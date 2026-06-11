import type { Address, EvmChainId, Hex } from '@concierge/shared';
import { z } from 'zod';

export const ETHENA_ATTESTATION_SCHEMAS = {
  wrap: 'concierge.ethena.wrap.v1',
  unwrap: 'concierge.ethena.unwrap.v1',
} as const;

const NON_NEG_INT_STR = z.string().regex(/^\d+$/);

export const AttestationPayloadSchema = z.object({
  schema: z.enum([ETHENA_ATTESTATION_SCHEMAS.wrap, ETHENA_ATTESTATION_SCHEMAS.unwrap]),
  chain: z.number(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: NON_NEG_INT_STR,
  amountOut: NON_NEG_INT_STR,
  txHash: z.string(),
  ts: z.number(),
});

export type AttestationPayload = z.infer<typeof AttestationPayloadSchema>;

export interface AttestationContext {
  action: 'wrap' | 'unwrap';
  chainId: EvmChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  txHash: Hex;
}

export function buildAttestationPayload(ctx: AttestationContext): AttestationPayload {
  return {
    schema: ETHENA_ATTESTATION_SCHEMAS[ctx.action],
    chain: ctx.chainId,
    tokenIn: ctx.tokenIn,
    tokenOut: ctx.tokenOut,
    amountIn: ctx.amountIn.toString(),
    amountOut: ctx.amountOut.toString(),
    txHash: ctx.txHash,
    ts: Math.floor(Date.now() / 1000),
  };
}
