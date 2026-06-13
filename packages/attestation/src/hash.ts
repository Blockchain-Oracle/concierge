import { type Hex, keccak256, toBytes } from 'viem';
import { canonicalize } from './canonicalize.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope } from './schema.ts';

/**
 * Compute the ReputationRegistry `dataHash` for an off-chain feedback
 * envelope. The bytes32 returned is the EXACT value `giveFeedback` expects
 * on Mantle — keccak256 of the UTF-8-encoded canonical JSON.
 *
 * **NOT EIP-712 typed-data hashing.** EIP-712 is for signed messages with
 * domain separation; ERC-8004 `giveFeedback(agentId, dataHash)` accepts a
 * raw bytes32 content hash. Per the story spec + `research/concierge/
 * 03-providers/erc8004.md` § attestation flow.
 *
 * Validation runs FIRST so malformed envelopes throw a Zod error (clear
 * field-level diagnostic) instead of a meaningless hash mismatch later.
 */
export function computeFeedbackHash(envelope: FeedbackEnvelope): Hex {
  // Validate at the boundary — throws ZodError on bad input.
  parseFeedbackEnvelope(envelope);
  const canonical = canonicalize(envelope);
  return keccak256(toBytes(canonical));
}

/**
 * Lower-level variant for callers that already validated the envelope
 * (e.g. inside a Zod transform pipeline). Skips the parse step; keep the
 * happy path single-traversal.
 */
export function computeFeedbackHashUnchecked(envelope: FeedbackEnvelope): Hex {
  const canonical = canonicalize(envelope);
  return keccak256(toBytes(canonical));
}
