import { z } from 'zod';

/**
 * Canonical schema discriminator strings — one per provider's attestation
 * shape. Mirrors story-67 `providerSchemaIdSchema` so the on-chain
 * attestation pointer + the off-chain envelope's `schema` field are
 * byte-equal.
 *
 * **Dual-versioning intent (round-1 doc):** envelope `v` versions the
 * wrapper shape; the `.vN` suffix in the schema id versions the payload
 * shape. They evolve INDEPENDENTLY — `concierge.aave.v3.supply.v2` can
 * ship under envelope `v: 1`.
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

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: false, message: 'createdAt must be a UTC ISO-8601 datetime (suffix Z).' });

/** 0x-prefixed lowercase 32-byte hex. Lowercase-only so canonicalize-then-hash is case-stable. */
const hash32Schema = z
  .string()
  .regex(/^0x[a-f0-9]{64}$/, '32-byte hex MUST be lowercase to canonicalize stably.');

/**
 * v1 feedback envelope. Round-1: `schema` is now a `z.discriminatedUnion`
 * over each SCHEMA_ID's literal — illegal schema ids fail at envelope
 * parse, not at a downstream allowlist check. Each variant carries the
 * same wrapper shape with `payload: unknown` — provider packages refine
 * payload via their own per-schema parsers; THIS layer is the shape gate.
 */
const envelopeVariant = (schemaId: SchemaId) =>
  z.object({
    v: z.literal(1),
    schema: z.literal(schemaId),
    agentId: z.string().min(1).max(128),
    chainId: z.number().int().nonnegative(),
    txHash: hash32Schema.optional(),
    payload: z.unknown(),
    createdAt: isoDateTimeSchema,
  });

const variants = SCHEMA_IDS.map(envelopeVariant) as unknown as readonly [
  ReturnType<typeof envelopeVariant>,
  ...ReturnType<typeof envelopeVariant>[],
];

export const feedbackEnvelopeSchema = z.discriminatedUnion('schema', variants);
export type FeedbackEnvelope = z.infer<typeof feedbackEnvelopeSchema>;

/**
 * Thin parse wrapper for symmetry with the rest of the SDK. The
 * unknown-schema-id case is now Zod's native discriminated-union error
 * (which lists all known ids), so the round-1 hand-thrown branch is gone.
 */
export function parseFeedbackEnvelope(input: unknown): FeedbackEnvelope {
  return feedbackEnvelopeSchema.parse(input);
}
