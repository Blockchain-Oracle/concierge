import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId } from '@concierge/shared';
import { z } from 'zod';
import { NON_NEG_INT_STR, NON_ZERO_ADDRESS, POSITIVE_INT_STR } from './_validators.ts';

export const ONDO_ATTESTATION_SCHEMA = 'concierge.ondo.read.v1' as const;

export const AttestationPayloadSchema = z.object({
  schema: z.literal(ONDO_ATTESTATION_SCHEMA),
  chain: z.number().int().positive(),
  user: NON_ZERO_ADDRESS,
  balance: NON_NEG_INT_STR,
  multiplier: POSITIVE_INT_STR,
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
  try {
    return AttestationPayloadSchema.parse(raw);
  } catch (err) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/ondo-usdy] attestation: payload validation failed — ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
}
