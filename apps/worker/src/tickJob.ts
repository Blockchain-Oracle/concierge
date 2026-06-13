import { sanitizeError } from '@concierge/runtime';
import type { Job } from 'bullmq';
import { assertAgentId } from './agentId.ts';
import type { DeadLetterQueue } from './dlq.ts';

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Tick result the orchestrator returns. The skip variants are SUCCESSES,
 * NOT failures (per CLAUDE.md no-silent-failures + story-68 spec).
 *
 * - `already_running`: another worker holds the lock — a real production
 *   skip, mark BullMQ job completed, don't retry.
 * - `not_wired`: runtime tick not yet bound (boot-time stub gate). Logged
 *   loudly via `logger.warn` and counted separately so deploy dashboards
 *   surface "story-69 not landed" rather than blending with normal skips.
 */
export type TickJobResult =
  | { readonly outcome: 'ok'; readonly tickId: string }
  | { readonly outcome: 'skipped'; readonly reason: 'already_running' | 'not_wired' };

export interface TickJobLogger {
  debug(meta: Record<string, unknown>, msg: string): void;
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
  error(meta: Record<string, unknown>, msg: string): void;
}

export interface MakeTickJobDeps {
  /** Bound tick fn from @concierge/runtime; tests stub. */
  readonly runTick: (agentId: string, signal: AbortSignal) => Promise<TickJobResult>;
  readonly dlq: DeadLetterQueue;
  readonly logger: TickJobLogger;
  readonly maxAttempts?: number;
}

/** Sanitize a thrown error's message via the shared runtime sanitizer (apikey URL strip, etc.). */
function sanitizedReason(err: unknown): string {
  return sanitizeError(err).message;
}

/**
 * Build the BullMQ job processor. BullMQ v5 semantics: `job.attemptsMade`
 * is the count of previously COMPLETED attempts; on the first try it is 0.
 * Compare `attemptsMade + 1 >= maxAttempts` to detect the FINAL try.
 *
 * Failure matrix:
 *   - tick returns ok/skipped    → complete
 *   - tick throws + attempt < N  → rethrow → BullMQ retries with backoff
 *   - tick throws + attempt = N  → enqueue DLQ, then rethrow (BullMQ marks
 *                                  failed; DLQ row is the reconcile signal)
 *   - DLQ enqueue THROWS         → log distinct error; rethrow ORIGINAL
 *                                  tick error so the failed-handler still
 *                                  sees the real cause (round-1 fix).
 */
export function makeTickJob(deps: MakeTickJobDeps) {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return async function tickJob(
    job: Job<{ readonly agentId: string }>,
    signal: AbortSignal,
  ): Promise<TickJobResult> {
    const { agentId } = job.data;
    assertAgentId(agentId, 'tickJob');
    try {
      const result = await deps.runTick(agentId, signal);
      if (result.outcome === 'skipped') {
        const fn = result.reason === 'not_wired' ? deps.logger.warn : deps.logger.debug;
        fn.call(deps.logger, { agentId, jobId: job.id, reason: result.reason }, 'tick skipped');
      } else {
        deps.logger.info({ agentId, jobId: job.id, tickId: result.tickId }, 'tick ok');
      }
      return result;
    } catch (err) {
      const attempts = job.attemptsMade + 1;
      const reason = sanitizedReason(err);
      deps.logger.error({ agentId, jobId: job.id, attempts, maxAttempts, reason }, 'tick failed');
      if (attempts >= maxAttempts) {
        try {
          await deps.dlq.enqueue({
            agentId,
            attempts,
            failedReason: reason,
            failedAt: new Date().toISOString(),
          });
        } catch (dlqErr) {
          // Round-1 fix: surface DLQ failure DISTINCTLY so ops sees both
          // problems (the original tick failure AND the lost DLQ row). The
          // original `err` is the one that gets re-thrown to BullMQ.
          deps.logger.error(
            {
              agentId,
              jobId: job.id,
              attempts,
              reason,
              dlqError: sanitizedReason(dlqErr),
              errorId: 'dlq_enqueue_failed',
            },
            'DLQ enqueue failed; original tick failure preserved',
          );
        }
      }
      throw err;
    }
  };
}
