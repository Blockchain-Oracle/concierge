import { z } from 'zod';

/**
 * Schema for the `policy_json` jsonb column on session_keys.
 *
 * **validUntil is the authoritative expiry source** (round-2 fix). Round-1
 * stored it only as a column on the table; a DB-write attacker could mutate
 * the column to extend session lifetime past what the EIP-712-signed policy
 * actually grants. Now we mirror it inside the signature-covered policyJson
 * and the column becomes a query-only convenience that loadSessionKey
 * cross-checks against policy.validUntil.
 *
 * `.strict()` rejects unexpected fields so a future writer that adds an
 * un-vetted key doesn't silently land in the bytea-bound shape.
 */
export const policyJsonSchema = z
  .object({
    /** EIP-712 typed-data hash the owner signed — 32 bytes hex. */
    enableTypedDataHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    /** Raw policy enable bytes — 0x-prefixed byte-aligned hex. */
    encodedPolicy: z.string().regex(/^0x([0-9a-fA-F]{2})+$/),
    /** 65-byte EIP-712 signature. */
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    /** Unix seconds — authoritative not-before bound. */
    validAfter: z.number().int().nonnegative(),
    /** Unix seconds — authoritative expiry. Cross-checked against the column on load. */
    validUntil: z.number().int().nonnegative(),
    ownerAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
  })
  .strict();

export type PolicyJson = z.infer<typeof policyJsonSchema>;
