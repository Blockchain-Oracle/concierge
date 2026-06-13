import { ConciergeError } from '@concierge/sdk';
import { sanitizeError } from '../sanitize.ts';
import type { AgentState, PhaseOutcome } from '../types.ts';
import type { ApprovedProposal, EoaQueueEnqueue, ExecutionRepository } from './execute.ts';
import type { ExecuteOutcome, ExecutionRow } from './executeSchema.ts';

/** Stderr fallback so a gas-drift signal cannot be silently disabled by an unwired logDrift dep. */
export function defaultDriftLog(msg: string): void {
  process.stderr.write(`[concierge/runtime] ${msg}\n`);
}

/** Safe-range note: bigint→number via `(actual*10000n)/estimate` is lossless for gas values < ~9e14. */
export function driftPct(actual: bigint, estimate: bigint): number {
  if (estimate === 0n) return Number.POSITIVE_INFINITY;
  const ratio = Number((actual * 10_000n) / estimate) / 10_000;
  return Math.abs(ratio - 1) * 100;
}

/**
 * Insert an execution row; on failure throw RpcError carrying the row payload
 * in metadata so ops can reconcile (orphaned UserOp on bundler + no DB trace).
 */
export async function insertOrThrow(
  repo: ExecutionRepository,
  row: ExecutionRow,
): Promise<{ readonly id: string }> {
  try {
    return await repo.insert(row);
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute: execution row insert failed (proposalId=${row.proposalId}${row.userOpHash ? ` userOpHash=${row.userOpHash}` : ''}): ${safe.message}`,
      safe,
      {
        proposalId: row.proposalId,
        agentId: row.agentId,
        ...(row.userOpHash !== undefined ? { userOpHash: row.userOpHash } : {}),
      },
    );
  }
}

export async function eoaFallback(
  inputs: { readonly state: AgentState; readonly proposal: ApprovedProposal },
  deps: { readonly eoaQueue: EoaQueueEnqueue; readonly repository: ExecutionRepository },
): Promise<PhaseOutcome<ExecuteOutcome>> {
  let queued: { readonly queueId: string };
  try {
    queued = await deps.eoaQueue.enqueue({
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
    });
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute (EOA fallback): enqueue failed: ${safe.message}`,
      safe,
    );
  }
  let row: { readonly id: string };
  try {
    row = await deps.repository.insert({
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
      status: 'awaiting_user_signature',
    });
  } catch (err) {
    // Orphan reconciliation: insert failed AFTER the queue entry committed.
    // proposalId + queueId structured for ops; queueId also in message for grep.
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute (EOA fallback): row insert failed AFTER queue enqueue; reconcile queueId=${queued.queueId}: ${safe.message}`,
      safe,
      { proposalId: inputs.proposal.id, agentId: inputs.state.agentId, queueId: queued.queueId },
    );
  }
  return {
    kind: 'continue',
    data: {
      status: 'awaiting_user_signature',
      executionId: row.id,
      queueId: queued.queueId,
    },
  };
}
