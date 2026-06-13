import { ConciergeError } from '@concierge/sdk';
import type { Job } from 'bullmq';
import type { DeadLetterQueue } from './dlq.ts';

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Tick result the orchestrator returns. The skip variant is a SUCCESS, not
 * a failure (per CLAUDE.md no-silent-failures: a skipped tick = "another
 * worker holds the lock" — mark BullMQ job completed, don't retry).
 */
export type TickJobResult =
  | { readonly outcome: 'ok'; readonly tickId: string }
  | { readonly outcome: 'skipped'; readonly reason: 'already_running' };

export interface TickJobLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface MakeTickJobDeps {
  /** Bound tick fn from @concierge/runtime; tests stub. */
  readonly runTick: (agentId: string, signal: AbortSignal) => Promise<TickJobResult>;
  readonly dlq: DeadLetterQueue;
  readonly logger: TickJobLogger;
  readonly maxAttempts?: number;
}

/**
 * Build the BullMQ job processor. Failure handling matrix:
 *   - tick returns 'ok'        → job completes
 *   - tick returns 'skipped'   → job completes (lock contention = success)
 *   - tick throws + attempt < max → rethrow so BullMQ retries with backoff
 *   - tick throws + attempt == max → enqueue to DLQ, then return normally
 *     (BullMQ marks the original job 'failed' but the DLQ row is the
 *     reconcile signal)
 */
export function makeTickJob(deps: MakeTickJobDeps) {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return async function tickJob(
    job: Job<{ readonly agentId: string }>,
    signal: AbortSignal,
  ): Promise<TickJobResult> {
    const { agentId } = job.data;
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
      throw new ConciergeError(
        'InvariantViolation',
        `[@concierge/worker] tickJob: agentId must match ${AGENT_ID_RE.source}.`,
      );
    }
    try {
      const result = await deps.runTick(agentId, signal);
      if (result.outcome === 'skipped') {
        deps.logger.debug('tick skipped: lock held', { agentId, jobId: job.id });
      } else {
        deps.logger.info('tick ok', { agentId, jobId: job.id, tickId: result.tickId });
      }
      return result;
    } catch (err) {
      const attempts = job.attemptsMade + 1;
      const reason = err instanceof Error ? err.message : String(err);
      deps.logger.error('tick failed', {
        agentId,
        jobId: job.id,
        attempts,
        maxAttempts,
        reason,
      });
      if (attempts >= maxAttempts) {
        // Final retry exhausted — route to DLQ for manual review.
        await deps.dlq.enqueue({
          agentId,
          attempts,
          failedReason: reason,
          failedAt: new Date().toISOString(),
        });
      }
      throw err;
    }
  };
}
