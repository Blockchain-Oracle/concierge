import { ConciergeError } from '@concierge/sdk';
import type { Queue } from 'bullmq';
import { assertAgentId } from './agentId.ts';

export const TICK_QUEUE_NAME = 'concierge-ticks';

const MIN_CADENCE_MS = 5_000; // 5s floor — tighter hammers the bundler

export interface ScheduleAgentTicksOpts {
  readonly agentId: string;
  readonly cadenceMs: number;
}

/**
 * Add (or update) a per-agent repeatable BullMQ job. `repeat.key` is the
 * load-bearing dedup signal — re-adding the same agent with a different
 * cadence REPLACES the prior schedule. Per `research/concierge/04-agent-
 * runtime.md` § 5.
 *
 * **Caller contract:** Rejection means the schedule did NOT land. The
 * caller is responsible for retry; failed schedules are NOT persisted to
 * any DLQ on this side. Wire retries at the orchestrator boundary.
 */
export async function scheduleAgentTicks(
  queue: Queue,
  opts: ScheduleAgentTicksOpts,
): Promise<{ readonly jobId: string }> {
  assertAgentId(opts.agentId, 'scheduleAgentTicks');
  if (!Number.isFinite(opts.cadenceMs) || opts.cadenceMs < MIN_CADENCE_MS) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/worker] scheduleAgentTicks: cadenceMs must be finite and >= ${MIN_CADENCE_MS}.`,
    );
  }
  const key = `tick-${opts.agentId}`;
  const job = await queue.add(
    'tick',
    { agentId: opts.agentId },
    {
      repeat: { every: opts.cadenceMs, key },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );
  return { jobId: job.id ?? key };
}

/** Stop a per-agent schedule (idempotent — false if not present). */
export async function unscheduleAgentTicks(queue: Queue, agentId: string): Promise<boolean> {
  assertAgentId(agentId, 'unscheduleAgentTicks');
  return queue.removeJobScheduler(`tick-${agentId}`);
}
