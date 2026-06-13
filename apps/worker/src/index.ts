import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createDlq, DLQ_NAME } from './dlq.ts';
import { TICK_QUEUE_NAME } from './scheduler.ts';
import { makeTickJob, type TickJobResult } from './tickJob.ts';

const DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_BACKOFF_MS = 5_000;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`[@concierge/worker] missing required env: ${key}`);
  }
  return v;
}

async function main(): Promise<void> {
  const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const redisUrl = requireEnv('REDIS_URL');
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const dlqQueue = new Queue(DLQ_NAME, { connection });
  const dlq = createDlq(dlqQueue);

  // Stub tick — wired to @concierge/runtime tick() at the orchestrator seam.
  // Returning a NOT-YET-WIRED skip until story-69+ provides the agent state
  // loader. This keeps the worker process boot-clean without a half-built
  // hot-path (per CLAUDE.md non-negotiable #1: no half-built features).
  const runTick = async (agentId: string, _signal: AbortSignal): Promise<TickJobResult> => {
    logger.warn({ agentId }, 'tick stub: runtime wire pending');
    return { outcome: 'skipped', reason: 'already_running' };
  };

  const processor = makeTickJob({ runTick, dlq, logger });

  const worker = new Worker(
    TICK_QUEUE_NAME,
    async (job) => processor(job, AbortSignal.timeout(55_000)),
    {
      connection,
      concurrency: 5,
      // Per-job retry policy (DLQ routing on final exhaustion lives in tickJob).
      settings: { backoffStrategy: () => DEFAULT_BACKOFF_MS },
    },
  );

  worker.on('ready', () => logger.info('worker ready'));
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'job failed');
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutdown received; draining');
    try {
      await worker.close();
      await dlqQueue.close();
      await connection.quit();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
    // Force-exit after drain timeout if anything hangs.
    setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS).unref();
  });
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: top-level entrypoint
  console.error('[@concierge/worker] fatal:', err);
  process.exit(1);
});
