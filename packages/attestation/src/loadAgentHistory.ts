import { ConciergeError } from '@concierge/sdk';
import { type GetOrFetchDeps, getOrFetchPayload, type PayloadError } from './ipfsCache.ts';
import type { FeedbackEnvelope } from './schema.ts';

const IPFS_URI_PREFIX = 'ipfs://';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Fields every history entry carries regardless of payload status. */
export interface AgentHistoryEntryBase {
  readonly schema: string;
  readonly feedbackHash: `0x${string}`;
  readonly feedbackURI: string;
  readonly feedbackIndex: bigint;
  readonly clientAddress: string;
  readonly txHash: `0x${string}`;
  readonly blockNumber: bigint;
  readonly revoked: boolean;
}

/**
 * Round-1 type-design fix: discriminated union enforces payload/payloadError
 * mutual exclusion at the type level — consumers `switch (entry.status)`
 * instead of defensively null-checking both fields.
 */
export type AgentHistoryEntry =
  | (AgentHistoryEntryBase & { readonly status: 'ok'; readonly payload: FeedbackEnvelope })
  | (AgentHistoryEntryBase & { readonly status: 'error'; readonly payloadError: PayloadError });

/** Raw on-chain feedback entries — matches `@concierge/erc8004` FeedbackEntrySchema. */
export interface RawFeedbackEntry {
  readonly schema: string;
  readonly feedbackHash: `0x${string}`;
  readonly feedbackURI: string;
  readonly feedbackIndex: bigint;
  readonly clientAddress: string;
  readonly blockNumber: bigint;
  readonly txHash: `0x${string}`;
  readonly revoked: boolean;
}

export interface LoadAgentHistoryInputs {
  readonly agentId: bigint;
  readonly limit?: number;
  readonly offset?: number;
  readonly fromBlock?: bigint;
}

export interface LoadAgentHistoryDeps {
  /** Reads from ReputationRegistry — typically `erc8004Provider.readFeedback`. */
  readonly readFeedback: (args: {
    readonly agentId: bigint;
    readonly fromBlock?: bigint;
  }) => Promise<{ readonly entries: ReadonlyArray<RawFeedbackEntry> }>;
  readonly ipfs: GetOrFetchDeps;
}

export interface LoadAgentHistoryResult {
  readonly entries: ReadonlyArray<AgentHistoryEntry>;
  readonly totalCount: number;
  readonly limit: number;
  readonly offset: number;
}

function cidFromUri(uri: string): string | null {
  if (!uri.startsWith(IPFS_URI_PREFIX)) return null;
  const cid = uri.slice(IPFS_URI_PREFIX.length);
  return cid.length > 0 ? cid : null;
}

/**
 * Reads all on-chain feedback for an agent, paginates, and enriches each
 * entry with the IPFS-fetched envelope payload (or a typed `payloadError`).
 *
 * **Partial results over complete failure** (CLAUDE.md no-silent-failures
 * + UX): a single broken CID downgrades to `payloadError: 'NOT_FOUND'`
 * rather than throwing. The dashboard renders the broken one as a
 * placeholder and the rest are fine.
 *
 * **NO retries inside.** If `readFeedback` fails entirely, the typed RpcError
 * surfaces; the caller decides retry policy.
 */
export async function loadAgentHistory(
  inputs: LoadAgentHistoryInputs,
  deps: LoadAgentHistoryDeps,
): Promise<LoadAgentHistoryResult> {
  // Boundary fail-fast: limits are caller-controlled. Reject unbounded reads.
  const limit = inputs.limit ?? DEFAULT_LIMIT;
  const offset = inputs.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/attestation] loadAgentHistory: limit must be 1..${MAX_LIMIT} (got ${limit}).`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/attestation] loadAgentHistory: offset must be ≥ 0 (got ${offset}).`,
    );
  }
  if (inputs.agentId < 0n) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/attestation] loadAgentHistory: agentId must be ≥ 0.',
    );
  }

  const raw = await deps.readFeedback(
    inputs.fromBlock !== undefined
      ? { agentId: inputs.agentId, fromBlock: inputs.fromBlock }
      : { agentId: inputs.agentId },
  );
  const all = raw.entries;
  const page = all.slice(offset, offset + limit);

  // Enrich entries in parallel — bounded by `limit` (≤200) so the fan-out is
  // small. Per-entry failures degrade to `payloadError`, never throw.
  const enriched: ReadonlyArray<AgentHistoryEntry> = await Promise.all(
    page.map(async (entry): Promise<AgentHistoryEntry> => {
      const cid = cidFromUri(entry.feedbackURI);
      if (cid === null) {
        return { ...entry, status: 'error', payloadError: 'NOT_FOUND' };
      }
      const fetched = await getOrFetchPayload(cid, deps.ipfs);
      if (!fetched.ok) {
        return { ...entry, status: 'error', payloadError: fetched.error };
      }
      return { ...entry, status: 'ok', payload: fetched.envelope };
    }),
  );

  return {
    entries: enriched,
    totalCount: all.length,
    limit,
    offset,
  };
}
