import { ConciergeError } from '@concierge/sdk';
import type { Queue } from 'bullmq';

export const DLQ_NAME = 'failed-ticks';

export interface DlqRecord {
  readonly agentId: string;
  readonly attempts: number;
  readonly failedReason: string;
  readonly tickId?: string;
  readonly failedAt: string;
}

export interface DeadLetterQueue {
  enqueue(record: DlqRecord): Promise<{ readonly jobId: string }>;
}

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/** Default BullMQ-backed DLQ — production wires this; tests stub the interface. */
export function createDlq(queue: Queue): DeadLetterQueue {
  return {
    async enqueue(record) {
      if (!AGENT_ID_RE.test(record.agentId)) {
        throw new ConciergeError(
          'InvariantViolation',
          `[@concierge/worker] DLQ.enqueue: agentId must match ${AGENT_ID_RE.source}.`,
        );
      }
      // Keep payload bounded — failedReason from upstream may be unbounded.
      const safeRecord: DlqRecord = {
        ...record,
        failedReason: record.failedReason.slice(0, 4096),
      };
      const job = await queue.add('dlq-tick', safeRecord, {
        removeOnComplete: false, // DLQ payloads are kept for manual review
        removeOnFail: false,
      });
      return { jobId: job.id ?? `dlq-${record.agentId}-${record.attempts}` };
    },
  };
}
