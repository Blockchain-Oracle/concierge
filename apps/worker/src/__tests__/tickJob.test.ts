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

type LogCall = [Record<string, unknown>, string];
function makeLogger(): TickJobLogger & {
  debugs: LogCall[];
  infos: LogCall[];
  warns: LogCall[];
  errors: LogCall[];
} {
  const debugs: LogCall[] = [];
  const infos: LogCall[] = [];
  const warns: LogCall[] = [];
  const errors: LogCall[] = [];
  return {
    debugs,
    infos,
    warns,
    errors,
    debug: (meta, msg) => debugs.push([meta, msg]),
    info: (meta, msg) => infos.push([meta, msg]),
    warn: (meta, msg) => warns.push([meta, msg]),
    error: (meta, msg) => errors.push([meta, msg]),
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
    const tj = makeTickJob({
      runTick: vi.fn().mockResolvedValue({ outcome: 'ok', tickId: 't1' } satisfies TickJobResult),
      dlq: makeDlq(),
      logger,
    });
    const out = await tj(fakeJob(), new AbortController().signal);
    expect(out.outcome).toBe('ok');
    expect(logger.infos).toHaveLength(1);
    expect(logger.infos[0]?.[1]).toMatch(/tick ok/);
    expect(logger.errors).toHaveLength(0);
  });

  it('outcome=skipped reason=already_running → DEBUG level (success, not retry)', async () => {
    const logger = makeLogger();
    const tj = makeTickJob({
      runTick: vi.fn().mockResolvedValue({
        outcome: 'skipped',
        reason: 'already_running',
      } satisfies TickJobResult),
      dlq: makeDlq(),
      logger,
    });
    await tj(fakeJob(), new AbortController().signal);
    expect(logger.debugs).toHaveLength(1);
    expect(logger.debugs[0]?.[1]).toMatch(/skip/i);
    expect(logger.warns).toHaveLength(0);
    expect(logger.errors).toHaveLength(0);
  });

  it('outcome=skipped reason=not_wired → WARN level (boot-stub tripwire)', async () => {
    const logger = makeLogger();
    const tj = makeTickJob({
      runTick: vi
        .fn()
        .mockResolvedValue({ outcome: 'skipped', reason: 'not_wired' } satisfies TickJobResult),
      dlq: makeDlq(),
      logger,
    });
    await tj(fakeJob(), new AbortController().signal);
    expect(logger.warns).toHaveLength(1);
    expect(logger.debugs).toHaveLength(0);
  });
});

describe('makeTickJob — BullMQ attemptsMade semantics (v5)', () => {
  // BullMQ v5: attemptsMade is COMPLETED attempts BEFORE this run. On the
  // first run it's 0; on the 3rd retry of a 3-attempt config it's 2.
  it('first attempt (attemptsMade=0) → rethrow; DLQ NOT called', async () => {
    const dlq = makeDlq();
    const tj = makeTickJob({
      runTick: vi.fn().mockRejectedValue(new Error('rpc')),
      dlq,
      logger: makeLogger(),
    });
    await expect(tj(fakeJob({ attemptsMade: 0 }), new AbortController().signal)).rejects.toThrow(
      'rpc',
    );
    expect(dlq.calls).toHaveLength(0);
  });

  it('final attempt (attemptsMade=2 / maxAttempts=3) → DLQ enqueued; original error rethrows', async () => {
    const dlq = makeDlq();
    const tj = makeTickJob({
      runTick: vi.fn().mockRejectedValue(new Error('persistent failure detail')),
      dlq,
      logger: makeLogger(),
      maxAttempts: 3,
    });
    await expect(tj(fakeJob({ attemptsMade: 2 }), new AbortController().signal)).rejects.toThrow(
      'persistent failure detail',
    );
    expect(dlq.calls).toHaveLength(1);
    const rec = dlq.calls[0] as { attempts: number };
    expect(rec.attempts).toBe(3);
  });
});

describe('makeTickJob — round-1 fixes', () => {
  it('DLQ.enqueue throws during final attempt → ORIGINAL tick error still rethrown', async () => {
    const dlq: DeadLetterQueue = {
      enqueue: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    const logger = makeLogger();
    const tj = makeTickJob({
      runTick: vi.fn().mockRejectedValue(new Error('original tick blew up')),
      dlq,
      logger,
      maxAttempts: 3,
    });
    let captured: unknown = null;
    try {
      await tj(fakeJob({ attemptsMade: 2 }), new AbortController().signal);
    } catch (e) {
      captured = e;
    }
    expect((captured as Error)?.message).toBe('original tick blew up');
    // Distinct dlq_enqueue_failed log line preserves visibility into the
    // secondary failure without losing the original cause.
    const dlqFail = logger.errors.find((e) => e[0]['errorId'] === 'dlq_enqueue_failed');
    expect(dlqFail).toBeTruthy();
  });

  it('sanitized failedReason: pimlico apikey URL in error.message → REDACTED in DLQ payload', async () => {
    const dlq = makeDlq();
    const tj = makeTickJob({
      runTick: vi
        .fn()
        .mockRejectedValue(new Error('failed at https://api.pimlico.io/v2/rpc?apikey=SECRET_KEY')),
      dlq,
      logger: makeLogger(),
      maxAttempts: 1,
    });
    await expect(tj(fakeJob({ attemptsMade: 0 }), new AbortController().signal)).rejects.toThrow();
    const rec = dlq.calls[0] as { failedReason: string };
    expect(rec.failedReason).not.toContain('SECRET_KEY');
  });

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
