import { sanitizeError } from '@concierge/runtime';
import { ConciergeError } from '@concierge/sdk';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createDlq, DLQ_NAME } from './dlq.ts';
import { TICK_QUEUE_NAME } from './scheduler.ts';
import { makeTickJob, type TickJobResult } from './tickJob.ts';

const DRAIN_TIMEOUT_MS = 60_000;
const TICK_TIMEOUT_MS = 55_000;
const DEFAULT_BACKOFF_MS = 5_000;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`[@concierge/worker] missing required env: ${key}`);
  }
  return v;
}

async function main(): Promise<void> {
  // Pino redact paths strip secrets that could leak from ioredis connection
  // errors (host:port:password) or Pimlico bundler URLs into prod log sinks.
  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: ['url', '*.url', 'password', '*.password', 'authorization', '*.authorization'],
      censor: '[REDACTED]',
    },
  });
  const redisUrl = requireEnv('REDIS_URL');
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const dlqQueue = new Queue(DLQ_NAME, { connection });
  const dlq = createDlq(dlqQueue);

  // Stub tick — wired to @concierge/runtime tick() at the orchestrator seam
  // in story-69. Gated behind WORKER_ALLOW_STUB=1 so a production deploy
  // missing the runtime wire FAILS LOUD instead of silently skipping every
  // tick forever. Per CLAUDE.md non-negotiable #1.
  const stubAllowed = process.env['WORKER_ALLOW_STUB'] === '1';
  const runTick = async (agentId: string, _signal: AbortSignal): Promise<TickJobResult> => {
    if (!stubAllowed) {
      throw new ConciergeError(
        'ConfigError',
        '[@concierge/worker] runtime tick not wired; set WORKER_ALLOW_STUB=1 to run with the boot stub.',
      );
    }
    logger.warn({ agentId }, 'tick stub: runtime wire pending');
    return { outcome: 'skipped', reason: 'not_wired' };
  };

  const processor = makeTickJob({ runTick, dlq, logger });

  const worker = new Worker(
    TICK_QUEUE_NAME,
    async (job) => processor(job, AbortSignal.timeout(TICK_TIMEOUT_MS)),
    {
      connection,
      concurrency: 5,
      settings: { backoffStrategy: () => DEFAULT_BACKOFF_MS },
    },
  );

  worker.on('ready', () => logger.info('worker ready'));
  worker.on('failed', (job, err) => {
    // Sanitize through the shared runtime sanitizer so Pimlico URLs / api
    // keys never reach the log sink. tickJob already DLQs on final attempt;
    // here we just record the per-attempt failure for observability.
    const sanitized = sanitizeError(err);
    logger.error(
      { jobId: job?.id, err: sanitized.message },
      'job failed (per-attempt; DLQ on final via tickJob)',
    );
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutdown received; draining');
    try {
      await worker.close();
      await dlqQueue.close();
      await connection.quit();
      process.exit(0);
    } catch (err) {
      // Round-1 fix: drain failure was silently exiting 0 (orchestrators read
      // it as clean). Surface the failure with exit 1 so Fly/k8s sees the
      // unclean shutdown and counts the deploy as bad.
      logger.error({ err: sanitizeError(err).message }, 'shutdown drain failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
    setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS).unref();
  });
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // Top-level entry: route through pino with redact paths so even an ioredis
  // connection-error stack carrying `rediss://default:PASSWORD@host` lands
  // sanitized. The fallback console.error is plain text without secrets.
  const fallback = pino({ level: 'error' });
  fallback.error({ err: sanitizeError(err).message }, '[@concierge/worker] fatal');
  process.exit(1);
});
