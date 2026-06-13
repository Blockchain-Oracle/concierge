import { ConciergeError } from '@concierge/sdk';
import type { Queue } from 'bullmq';

export const TICK_QUEUE_NAME = 'concierge-ticks';

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MIN_CADENCE_MS = 5_000; // 5s floor — anything tighter hammers the bundler

export interface ScheduleAgentTicksOpts {
  readonly agentId: string;
  readonly cadenceMs: number;
}

/**
 * Add (or update) a per-agent repeatable BullMQ job. The `repeat.key` is the
 * load-bearing dedup signal — re-adding the same agent with a different
 * cadence REPLACES the prior schedule rather than spawning a duplicate. Per
 * `research/concierge/04-agent-runtime.md` § 5.
 */
export async function scheduleAgentTicks(
  queue: Queue,
  opts: ScheduleAgentTicksOpts,
): Promise<{ readonly jobId: string }> {
  if (!AGENT_ID_RE.test(opts.agentId)) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/worker] scheduleAgentTicks: agentId must match ${AGENT_ID_RE.source}.`,
    );
  }
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
  if (!AGENT_ID_RE.test(agentId)) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/worker] unscheduleAgentTicks: agentId must match ${AGENT_ID_RE.source}.`,
    );
  }
  return queue.removeJobScheduler(`tick-${agentId}`);
}
