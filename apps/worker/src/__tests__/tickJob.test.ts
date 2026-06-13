import { ConciergeError } from '@concierge/sdk';
import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeadLetterQueue } from '../dlq.ts';
import { makeTickJob, type TickJobLogger, type TickJobResult } from '../tickJob.ts';

afterEach(() => vi.restoreAllMocks());

function fakeJob(over: Partial<Job<{ agentId: string }>> = {}): Job<{ agentId: string }> {
  return {
    id: 'job-1',
    data: { agentId: 'agent-1' },
    attemptsMade: 0,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: minimal bullmq stub
  } as any;
}

function makeLogger(): TickJobLogger & {
  debugs: Array<[string, Record<string, unknown> | undefined]>;
  infos: Array<[string, Record<string, unknown> | undefined]>;
  errors: Array<[string, Record<string, unknown> | undefined]>;
} {
  const debugs: Array<[string, Record<string, unknown> | undefined]> = [];
  const infos: Array<[string, Record<string, unknown> | undefined]> = [];
  const errors: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    debugs,
    infos,
    errors,
    debug: (m, x) => debugs.push([m, x]),
    info: (m, x) => infos.push([m, x]),
    error: (m, x) => errors.push([m, x]),
  };
}

function makeDlq(): DeadLetterQueue & { calls: Array<unknown> } {
  const calls: Array<unknown> = [];
  return {
    calls,
    enqueue: vi.fn().mockImplementation(async (r) => {
      calls.push(r);
      return { jobId: 'dlq-1' };
    }),
  };
}

describe('makeTickJob — happy paths', () => {
  it('outcome=ok → logs info, returns result', async () => {
    const logger = makeLogger();
    const dlq = makeDlq();
    const tj = makeTickJob({
      runTick: vi.fn().mockResolvedValue({ outcome: 'ok', tickId: 't1' } satisfies TickJobResult),
      dlq,
      logger,
    });
    const out = await tj(fakeJob(), new AbortController().signal);
    expect(out.outcome).toBe('ok');
    expect(logger.infos).toHaveLength(1);
    expect(logger.errors).toHaveLength(0);
  });

  it('outcome=skipped → logs DEBUG (not error/info), job completes normally', async () => {
    const logger = makeLogger();
    const tj = makeTickJob({
      runTick: vi.fn().mockResolvedValue({
        outcome: 'skipped',
        reason: 'already_running',
      } satisfies TickJobResult),
      dlq: makeDlq(),
      logger,
    });
    const out = await tj(fakeJob(), new AbortController().signal);
    expect(out.outcome).toBe('skipped');
    expect(logger.debugs).toHaveLength(1);
    expect(logger.infos).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });
});

describe('makeTickJob — retry + DLQ', () => {
  it('throws on non-final attempt → rethrows for BullMQ to retry; DLQ NOT called', async () => {
    const logger = makeLogger();
    const dlq = makeDlq();
    const tj = makeTickJob({
      runTick: vi.fn().mockRejectedValue(new Error('rpc')),
      dlq,
      logger,
    });
    await expect(tj(fakeJob({ attemptsMade: 0 }), new AbortController().signal)).rejects.toThrow(
      'rpc',
    );
    expect(dlq.calls).toHaveLength(0);
    expect(logger.errors).toHaveLength(1);
  });

  it('throws on FINAL attempt → enqueues DLQ with attempts + sanitized reason', async () => {
    const logger = makeLogger();
    const dlq = makeDlq();
    const tj = makeTickJob({
      runTick: vi.fn().mockRejectedValue(new Error('persistent failure detail')),
      dlq,
      logger,
      maxAttempts: 3,
    });
    await expect(tj(fakeJob({ attemptsMade: 2 }), new AbortController().signal)).rejects.toThrow(
      'persistent failure detail',
    );
    expect(dlq.calls).toHaveLength(1);
    const rec = dlq.calls[0] as { agentId: string; attempts: number; failedReason: string };
    expect(rec.agentId).toBe('agent-1');
    expect(rec.attempts).toBe(3);
    expect(rec.failedReason).toContain('persistent failure detail');
  });
});

describe('makeTickJob — boundary', () => {
  it('malformed agentId in job data → InvariantViolation', async () => {
    const tj = makeTickJob({
      runTick: vi.fn(),
      dlq: makeDlq(),
      logger: makeLogger(),
    });
    await expect(
      tj(fakeJob({ data: { agentId: 'bad agent:id' } }), new AbortController().signal),
    ).rejects.toBeInstanceOf(ConciergeError);
  });
});
