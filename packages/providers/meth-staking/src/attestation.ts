import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId } from '@concierge/shared';
import { z } from 'zod';
import { NON_NEG_INT_STR, NON_ZERO_ADDRESS, POSITIVE_INT_STR } from './_validators.ts';

export const METH_READ_SCHEMA = 'concierge.meth.read.v1' as const;
export const METH_UNWRAP_SCHEMA = 'concierge.meth.unwrap-via-dex.v1' as const;

export const ReadAttestationPayloadSchema = z.object({
  schema: z.literal(METH_READ_SCHEMA),
  chain: z.literal(5000),
  user: NON_ZERO_ADDRESS,
  balance: NON_NEG_INT_STR,
  exchangeRate: POSITIVE_INT_STR,
  blockNumber: z.number().int().positive(),
  ts: z.number().int().positive(),
});

export const UnwrapAttestationPayloadSchema = z.object({
  schema: z.literal(METH_UNWRAP_SCHEMA),
  chain: z.literal(5000),
  dexTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  amountMethIn: POSITIVE_INT_STR,
  expectedEthOut: NON_NEG_INT_STR,
  actualEthOut: NON_NEG_INT_STR,
  slippageBps: z.number().int().min(1).max(5000),
  ts: z.number().int().positive(),
});

export type ReadAttestationPayload = z.infer<typeof ReadAttestationPayloadSchema>;
export type UnwrapAttestationPayload = z.infer<typeof UnwrapAttestationPayloadSchema>;

export interface ReadAttestationContext {
  chainId: EvmChainId;
  user: Address;
  balance: bigint;
  exchangeRate: bigint;
  blockNumber: number;
}

export function buildReadAttestationPayload(ctx: ReadAttestationContext): ReadAttestationPayload {
  if (ctx.balance < 0n) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/meth-staking] attestation: balance must be non-negative',
    );
  }
  if (ctx.exchangeRate <= 0n) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/meth-staking] attestation: exchangeRate must be positive',
    );
  }
  const raw = {
    schema: METH_READ_SCHEMA,
    chain: ctx.chainId,
    user: ctx.user,
    balance: ctx.balance.toString(),
    exchangeRate: ctx.exchangeRate.toString(),
    blockNumber: ctx.blockNumber,
    ts: Math.floor(Date.now() / 1000),
  };
  try {
    return ReadAttestationPayloadSchema.parse(raw);
  } catch (err) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/meth-staking] attestation: payload validation failed — ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
}
