import { type Hex, keccak256, toBytes } from 'viem';
import { canonicalize } from './canonicalize.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope } from './schema.ts';

/**
 * Compute the ReputationRegistry `dataHash` for an off-chain feedback envelope.
 * Returns the 32-byte hex that `giveFeedback(agentId, dataHash)` expects on
 * Mantle. Validates first (Zod) so malformed envelopes throw a field-level
 * diagnostic instead of silently producing a non-matching hash.
 *
 * NOT EIP-712 — see ADR-004 + research/concierge/03-providers/erc8004.md.
 */
export function computeFeedbackHash(envelope: FeedbackEnvelope): Hex {
  parseFeedbackEnvelope(envelope);
  return keccak256(toBytes(canonicalize(envelope)));
}
