import { type Hex, keccak256, toBytes } from 'viem';
import { canonicalize } from './canonicalize.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope } from './schema.ts';

/**
 * Compute the ReputationRegistry `dataHash` for an off-chain feedback envelope.
 * Validates first (Zod), then canonicalizes, then keccak256s the UTF-8 bytes.
 * Throws ZodError on malformed envelope. See ADR-004 (NOT EIP-712).
 */
export function computeFeedbackHash(envelope: FeedbackEnvelope): Hex {
  return computeFeedbackPair(envelope).hash;
}

/**
 * Return BOTH the hash AND the canonical bytes in one pass — the canonical
 * string IS the off-chain content that gets pinned to IPFS, and `hash ===
 * keccak256(toBytes(canonical))` is provable by construction here. Avoids
 * the round-trip where story-81's IPFS pin would otherwise re-canonicalize.
 */
export function computeFeedbackPair(envelope: FeedbackEnvelope): {
  readonly hash: Hex;
  readonly canonical: string;
} {
  parseFeedbackEnvelope(envelope);
  const canonical = canonicalize(envelope);
  const hash = keccak256(toBytes(canonical));
  return { hash, canonical };
}
