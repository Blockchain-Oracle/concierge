import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId } from '@concierge/shared';
import { z } from 'zod';

const NON_NEG_INT_STR = z.string().regex(/^\d+$/, 'must be a non-negative integer string');
const NON_ZERO_ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((v) => v !== '0x0000000000000000000000000000000000000000', 'must not be zero address');

export const ONDO_ATTESTATION_SCHEMA = 'concierge.ondo.read.v1' as const;

export const AttestationPayloadSchema = z.object({
  schema: z.literal(ONDO_ATTESTATION_SCHEMA),
  chain: z.number().int().positive(),
  user: NON_ZERO_ADDRESS,
  balance: NON_NEG_INT_STR,
  multiplier: NON_NEG_INT_STR,
  blockNumber: z.number().int().positive(),
  ts: z.number().int().positive(),
});

export type AttestationPayload = z.infer<typeof AttestationPayloadSchema>;

export interface AttestationContext {
  chainId: EvmChainId;
  user: Address;
  balance: bigint;
  multiplier: bigint;
  blockNumber: number;
}

export function buildAttestationPayload(ctx: AttestationContext): AttestationPayload {
  if (ctx.balance < 0n) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/ondo-usdy] attestation: balance must be non-negative',
    );
  }
  if (ctx.multiplier <= 0n) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/ondo-usdy] attestation: multiplier must be positive (zero means pool price is invalid)',
    );
  }
  const raw = {
    schema: ONDO_ATTESTATION_SCHEMA,
    chain: ctx.chainId,
    user: ctx.user,
    balance: ctx.balance.toString(),
    multiplier: ctx.multiplier.toString(),
    blockNumber: ctx.blockNumber,
    ts: Math.floor(Date.now() / 1000),
  };
  return AttestationPayloadSchema.parse(raw);
}
