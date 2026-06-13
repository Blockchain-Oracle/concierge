import { z } from 'zod';

/**
 * Canonical schema discriminator strings — one per provider's attestation
 * shape. Mirrors story-67 `providerSchemaIdSchema` (lowercase + dot-segment +
 * `.v\d+`) so the on-chain attestation pointer + the off-chain envelope's
 * `schema` field are byte-equal.
 */
export const SCHEMA_IDS = [
  'concierge.aave.v3.supply.v1',
  'concierge.aave.v3.borrow.v1',
  'concierge.aave.v3.repay.v1',
  'concierge.aave.v3.withdraw.v1',
  'concierge.mantle-dex.swap.v1',
  'concierge.ethena.susde.wrap.v1',
  'concierge.ondo.usdy.subscribe.v1',
  'concierge.meth-staking.stake.v1',
  'concierge.lifi.bridge.v1',
] as const;
export type SchemaId = (typeof SCHEMA_IDS)[number];

/** ISO-8601 datetime per RFC 3339 — Zod v4 `.datetime()` is strict UTC. */
const isoDateTimeSchema = z.string().datetime({ offset: false });

/** 0x-prefixed 32-byte hex. Reused for txHash. */
const hash32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

/**
 * The v1 feedback envelope wrapping a per-provider payload. The `v` literal
 * is an explicit version gate — a future `v: 2` MUST be a distinct parser,
 * not a backwards-compat fork. `payload` is intentionally `z.unknown()` at
 * this layer; provider packages refine it via `discriminate(envelope)`.
 */
export const feedbackEnvelopeSchema = z.object({
  v: z.literal(1),
  schema: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  chainId: z.number().int().nonnegative(),
  txHash: hash32Schema.optional(),
  payload: z.unknown(),
  createdAt: isoDateTimeSchema,
});
export type FeedbackEnvelope = z.infer<typeof feedbackEnvelopeSchema>;

/**
 * Parse + assert the `schema` discriminator is a KNOWN id. Producing a
 * clear error message instead of a generic Zod-level rejection is the
 * BDD contract: ops should see "unknown schema 'concierge.foo.v1'" not
 * "expected one of [literal lists 9 entries deep]".
 */
export function parseFeedbackEnvelope(input: unknown): FeedbackEnvelope {
  const parsed = feedbackEnvelopeSchema.parse(input);
  if (!(SCHEMA_IDS as readonly string[]).includes(parsed.schema)) {
    throw new Error(
      `[@concierge/attestation] parseFeedbackEnvelope: unknown schema id '${parsed.schema}'. Known: ${SCHEMA_IDS.join(', ')}.`,
    );
  }
  return parsed;
}
