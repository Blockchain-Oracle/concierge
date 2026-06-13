import type { Queue } from 'bullmq';
import { assertAgentId } from './agentId.ts';

export const DLQ_NAME = 'failed-ticks';

const FAILED_REASON_CAP = 4096;

export interface DlqRecord {
  readonly agentId: string;
  readonly attempts: number;
  readonly failedReason: string;
  readonly failedAt: string;
}

export interface DeadLetterQueue {
  enqueue(record: DlqRecord): Promise<{ readonly jobId: string }>;
}

/** Default BullMQ-backed DLQ — production wires this; tests stub the interface. */
export function createDlq(queue: Queue): DeadLetterQueue {
  return {
    async enqueue(record) {
      assertAgentId(record.agentId, 'DLQ.enqueue');
      // Caller MUST already sanitize secrets out of failedReason. We cap length
      // here as a final DoS guard; we do NOT re-sanitize secrets at this layer
      // (one canonical sanitize point at tickJob keeps the contract clear).
      const safeRecord: DlqRecord = {
        ...record,
        failedReason: record.failedReason.slice(0, FAILED_REASON_CAP),
      };
      const job = await queue.add('dlq-tick', safeRecord, {
        removeOnComplete: false, // DLQ payloads are kept for manual review
        removeOnFail: false,
      });
      return { jobId: job.id ?? `dlq-${record.agentId}-${record.attempts}` };
    },
  };
}
