import { ZodError, z } from 'zod';

/**
 * Canonical schema discriminator strings — one per provider's attestation
 * shape. Mirrors story-67 `providerSchemaIdSchema` so the on-chain
 * attestation pointer + the off-chain envelope's `schema` field are
 * byte-equal.
 *
 * **Dual-versioning intent:** envelope `v` versions the wrapper shape;
 * the `.vN` suffix in the schema id versions the payload shape. They
 * evolve INDEPENDENTLY — `concierge.aave.v3.supply.v2` can ship under
 * envelope `v: 1`.
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

/**
 * 32-byte hex hash. Accepts mixed case at the boundary and normalizes via
 * `.transform(.toLowerCase())` so canonicalize-then-keccak stays stable
 * regardless of whether the caller passed viem (lowercase) or ethers v6
 * (mixed case) receipt hashes. (Round-2 fix — was silently rejecting ethers.)
 */
const hash32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, '32-byte hex required (0x + 64 hex chars).')
  .transform((s) => s.toLowerCase());

/**
 * v1 feedback envelope. Schema mandates `z.discriminatedUnion` via the
 * `schema` field (story-80 BDD line 23, grep gate verified). Variants
 * currently share the same wrapper shape; per-schema `payload` refinement
 * is reserved for the provider packages (story-83+).
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

/** Strip control chars from a string about to be embedded in an error message (CWE-117). */
function stripCtrl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CWE-117 mitigation requires control-char class
  return s.replace(/[\u0000-\u001f]/g, '?');
}

/**
 * Parse + sanitize. Round-2: Zod's discriminatedUnion error embeds the
 * offending `schema` value verbatim; we strip control chars before
 * re-throwing so log sinks can't be forged via `\n[ERROR] fake`.
 */
export function parseFeedbackEnvelope(input: unknown): FeedbackEnvelope {
  try {
    return feedbackEnvelopeSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(
        `[@concierge/attestation] parseFeedbackEnvelope: ${stripCtrl(err.message).slice(0, 2048)}`,
      );
    }
    throw err;
  }
}
