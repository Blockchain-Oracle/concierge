import { z } from 'zod';

/**
 * Schema for the `policy_json` jsonb column on session_keys. Persist writes it
 * with this exact shape; load parses on read so a future schema drift surfaces
 * as a typed `DecryptionFailed` (corruption) instead of a TypeError deep in the
 * worker. CLAUDE.md no-silent-failures.
 */
export const policyJsonSchema = z.object({
  /** EIP-712 typed-data hash the owner signed. */
  enableTypedDataHash: z.string().regex(/^0x[0-9a-fA-F]+$/),
  /** Raw policy enable bytes (validator data the on-chain enable consumes). */
  encodedPolicy: z.string().regex(/^0x[0-9a-fA-F]+$/),
  /** 65-byte EIP-712 signature. */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  validAfter: z.number().int().nonnegative(),
  ownerAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});

export type PolicyJson = z.infer<typeof policyJsonSchema>;
