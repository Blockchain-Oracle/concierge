import { z } from 'zod';

import { hash32Schema as HASH_32 } from './hash.ts';

/**
 * Attestation payload built by the originating provider. The runtime is
 * schema-agnostic — `providerSchema` + `payload` are passed verbatim to the
 * ERC-8004 client. Per-provider schemas (e.g. `concierge.aave.v3.borrow.v1`)
 * live in the provider package; record() trusts the result.
 */
/**
 * Per-provider schema id, e.g. `concierge.aave.v3.borrow.v1`. Enforced via
 * regex so the namespace convention can't drift (lowercase + dot-separated +
 * `.v<digits>` suffix). Length capped at 128 inline (drops MAX constant).
 */
// Round-2: require at least TWO leading segments (vendor + protocol) and
// versions starting at v1 (v0 has no semantic meaning today).
const providerSchemaIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(\.[a-z0-9]+)+\.v[1-9]\d*$/);

export const attestationPayloadSchema = z.object({
  providerSchema: providerSchemaIdSchema,
  payload: z.unknown(),
});
export type AttestationPayload = z.infer<typeof attestationPayloadSchema>;

export const RECORD_OUTCOMES = ['attested', 'already_attested', 'retry_queued'] as const;
export type RecordOutcomeKind = (typeof RECORD_OUTCOMES)[number];

export const recordOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attested'),
    executionId: z.string().min(1),
    attestationUid: HASH_32,
    attestationTxHash: HASH_32,
  }),
  z.object({
    kind: z.literal('already_attested'),
    executionId: z.string().min(1),
    attestationUid: HASH_32,
  }),
  z.object({
    kind: z.literal('retry_queued'),
    executionId: z.string().min(1),
    retryJobId: z.string().min(1),
  }),
]);
export type RecordOutcome = z.infer<typeof recordOutcomeSchema>;

/** Compile-time mirror so RECORD_OUTCOMES and RecordOutcome stay in lockstep. */
type _RecordKindMatch = RecordOutcome['kind'] extends RecordOutcomeKind
  ? RecordOutcomeKind extends RecordOutcome['kind']
    ? true
    : false
  : false;
const _recordKindCheck: _RecordKindMatch = true;
void _recordKindCheck;
