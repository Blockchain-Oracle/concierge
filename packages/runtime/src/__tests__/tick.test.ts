import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../tick.ts';
import type {
  AgentState,
  Attestation,
  Exec,
  PhaseOutcome,
  Plan,
  Proposal,
  Sim,
  TickConfig,
  TickLock,
  TickLogger,
} from '../types.ts';

afterEach(() => vi.restoreAllMocks());

const AGENT_ID = 'agent-test-1';

const SAMPLE_STATE: AgentState = {
  agentId: AGENT_ID,
  userId: 'user-1',
  chain: 'mantle-sepolia',
  goal: 'idle yield on USDC',
  policyId: 'policy-1',
  recentTicks: [],
  openPositions: [],
};

// Distinct branded fixtures so a mis-wired phase forward (e.g. plan flowing into propose)
// trips the toHaveBeenCalledWith assertion — pins the type-flow invariant.
const PLAN: Plan = { intent: 'plan-out', providerCalls: [] };
const SIM: Sim = {
  ok: true,
  gasEstimateWei: 7n,
  expectedValueDeltaUsd: 0.07,
  warnings: ['sim-out'],
};
const PROP: Proposal = { id: 'prop-out', requiresApproval: false, summary: 's', txParams: [] };
const EXEC: Exec = { txHashes: ['exec-out'], blockNumbers: [42n] };
const ATTEST: Attestation = { attestationUid: 'attest-out', recordedAt: new Date() };

function ok<T>(data: T): PhaseOutcome<T> {
  return { kind: 'continue', data };
}
function stop<T>(reason: string): PhaseOutcome<T> {
  return { kind: 'stop', reason };
}
function err<T>(error: unknown): PhaseOutcome<T> {
  return { kind: 'error', error };
}

interface Capture {
  acquired: { key: string; ttl: number }[];
  released: string[];
}

function makeLock(
  opts: { acquireReturns?: boolean; acquireThrows?: Error; releaseThrows?: Error } = {},
): {
  lock: TickLock;
  cap: Capture;
} {
  const cap: Capture = { acquired: [], released: [] };
  return {
    cap,
    lock: {
      async acquire(key, ttl) {
        if (opts.acquireThrows) throw opts.acquireThrows;
        cap.acquired.push({ key, ttl });
        return opts.acquireReturns ?? true;
      },
      async release(key) {
        cap.released.push(key);
        if (opts.releaseThrows) throw opts.releaseThrows;
        return 'released';
      },
    },
  };
}

function makeLogger(): TickLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeConfig(overrides: Partial<TickConfig> = {}): TickConfig {
  const { lock } = makeLock();
  return {
    agentId: AGENT_ID,
    loadState: vi.fn().mockResolvedValue(SAMPLE_STATE),
    plan: vi.fn().mockResolvedValue(ok(PLAN)),
    simulate: vi.fn().mockResolvedValue(ok(SIM)),
    propose: vi.fn().mockResolvedValue(ok(PROP)),
    execute: vi.fn().mockResolvedValue(ok(EXEC)),
    record: vi.fn().mockResolvedValue(ok(ATTEST)),
    lock,
    ...overrides,
  };
}

describe('tick — agentId validation (CWE-74)', () => {
  it('throws ConfigError when agentId contains a colon (Redis-key collision)', async () => {
    await expect(tick(makeConfig({ agentId: 'foo:bar' }))).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('throws ConfigError when agentId contains CRLF (Redis-protocol injection surface)', async () => {
    await expect(tick(makeConfig({ agentId: 'foo\r\nFLUSHDB' }))).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('throws ConfigError on empty agentId', async () => {
    await expect(tick(makeConfig({ agentId: '' }))).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('accepts safe charset (alnum / hyphen / underscore)', async () => {
    const result = await tick(makeConfig({ agentId: 'agent_42-prod' }));
    expect(result.kind).toBe('completed');
  });
});

describe('tick — lock contention', () => {
  it('returns { kind: "skipped" } when lock already held; does NOT load state', async () => {
    const { lock, cap } = makeLock({ acquireReturns: false });
    const loadState = vi.fn();
    const result = await tick(makeConfig({ lock, loadState }));
    expect(result).toEqual({ kind: 'skipped' });
    expect(cap.acquired).toEqual([{ key: `lock:agent:${AGENT_ID}`, ttl: 60_000 }]);
    expect(cap.released).toEqual([]);
    expect(loadState).not.toHaveBeenCalled();
  });

  it('default TTL is 60s, custom override honored', async () => {
    const { lock, cap } = makeLock();
    await tick(makeConfig({ lock }));
    expect(cap.acquired[0]?.ttl).toBe(60_000);
    const { lock: lock2, cap: cap2 } = makeLock();
    await tick(makeConfig({ lock: lock2, lockTtlMs: 10_000 }));
    expect(cap2.acquired[0]?.ttl).toBe(10_000);
  });

  it('Redis throw during acquire wraps as ConciergeError(RpcError) with structured log', async () => {
    const boom = new Error('NOAUTH Authentication required');
    const { lock } = makeLock({ acquireThrows: boom });
    const logger = makeLogger();
    await expect(tick(makeConfig({ lock, logger }))).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'LockError',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID, lockKey: `lock:agent:${AGENT_ID}` }),
      'tick.lock_acquire_failed',
    );
  });
});

describe('tick — phase sequencing happy path', () => {
  it('runs plan → simulate → propose → execute → record in order', async () => {
    const order: string[] = [];
    const cfg = makeConfig({
      plan: vi.fn(async () => {
        order.push('plan');
        return ok(PLAN);
      }),
      simulate: vi.fn(async () => {
        order.push('simulate');
        return ok(SIM);
      }),
      propose: vi.fn(async () => {
        order.push('propose');
        return ok(PROP);
      }),
      execute: vi.fn(async () => {
        order.push('execute');
        return ok(EXEC);
      }),
      record: vi.fn(async () => {
        order.push('record');
        return ok(ATTEST);
      }),
    });
    const result = await tick(cfg);
    expect(result).toEqual({ kind: 'completed', attestation: ATTEST });
    expect(order).toEqual(['plan', 'simulate', 'propose', 'execute', 'record']);
  });

  it('passes BRANDED prior-phase data into next phase (type-flow wiring)', async () => {
    const cfg = makeConfig();
    await tick(cfg);
    expect(cfg.plan).toHaveBeenCalledWith(SAMPLE_STATE, expect.any(AbortSignal));
    expect(cfg.simulate).toHaveBeenCalledWith(SAMPLE_STATE, PLAN, expect.any(AbortSignal));
    expect(cfg.propose).toHaveBeenCalledWith(SAMPLE_STATE, SIM, expect.any(AbortSignal));
    expect(cfg.execute).toHaveBeenCalledWith(SAMPLE_STATE, PROP, expect.any(AbortSignal));
    expect(cfg.record).toHaveBeenCalledWith(SAMPLE_STATE, EXEC, expect.any(AbortSignal));
  });
});

describe('tick — early returns (stop) by phase', () => {
  it('plan stop → halts BEFORE simulate; releases lock', async () => {
    const { lock, cap } = makeLock();
    const cfg = makeConfig({
      lock,
      plan: vi.fn().mockResolvedValue(stop('noop')),
      simulate: vi.fn(),
    });
    const result = await tick(cfg);
    expect(result).toEqual({ kind: 'stopped', phase: 'plan', reason: 'noop' });
    expect(cfg.simulate).not.toHaveBeenCalled();
    expect(cap.released).toEqual([`lock:agent:${AGENT_ID}`]);
  });

  it('execute stop (e.g. session-key revoked) halts BEFORE record', async () => {
    const cfg = makeConfig({
      execute: vi.fn().mockResolvedValue(stop('session_revoked')),
      record: vi.fn(),
    });
    const result = await tick(cfg);
    expect(result.kind).toBe('stopped');
    if (result.kind === 'stopped') expect(result.phase).toBe('execute');
    expect(cfg.record).not.toHaveBeenCalled();
  });
});

describe('tick — error handling + cause tagging', () => {
  it('phase returns error → cause: "returned"; skips subsequent phases', async () => {
    const boom = new Error('rpc 502');
    const cfg = makeConfig({
      simulate: vi.fn().mockResolvedValue(err(boom)),
      propose: vi.fn(),
    });
    const result = await tick(cfg);
    expect(result.kind).toBe('errored');
    if (result.kind === 'errored') {
      expect(result.phase).toBe('simulate');
      expect(result.cause).toBe('returned');
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/rpc 502/);
    }
    expect(cfg.propose).not.toHaveBeenCalled();
  });

  it('phase THROWS → cause: "thrown" (distinguishes programmer bugs from domain errors)', async () => {
    const { lock, cap } = makeLock();
    const cfg = makeConfig({
      lock,
      execute: vi.fn().mockRejectedValue(new TypeError('undefined.foo')),
      record: vi.fn(),
    });
    const result = await tick(cfg);
    expect(result.kind).toBe('errored');
    if (result.kind === 'errored') {
      expect(result.cause).toBe('thrown');
      expect(result.error.name).toBe('TypeError');
    }
    expect(cap.released).toEqual([`lock:agent:${AGENT_ID}`]);
    expect(cfg.record).not.toHaveBeenCalled();
  });

  it('record-phase ERROR releases lock AND logs execute_without_attestation warn', async () => {
    const { lock, cap } = makeLock();
    const logger = makeLogger();
    const cfg = makeConfig({
      lock,
      logger,
      record: vi.fn().mockResolvedValue(err(new Error('attestation rpc 500'))),
    });
    const result = await tick(cfg);
    expect(result.kind).toBe('errored');
    if (result.kind === 'errored') expect(result.phase).toBe('record');
    expect(cap.released).toEqual([`lock:agent:${AGENT_ID}`]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID }),
      'tick.execute_without_attestation',
    );
  });

  it('SECURITY: error messages are sanitized (Pimlico apikey URL params redacted)', async () => {
    const leak = new Error(
      'Pimlico 401 at https://api.pimlico.io/v2/mantle/rpc?apikey=FAKE_TEST_NOT_A_KEY',
    );
    const cfg = makeConfig({ simulate: vi.fn().mockResolvedValue(err(leak)) });
    const result = await tick(cfg);
    if (result.kind === 'errored') {
      expect(result.error.message).toContain('<redacted>');
      expect(result.error.message).not.toContain('FAKE_TEST_NOT_A_KEY');
    }
  });

  it('loadState throws → propagates after releasing lock', async () => {
    const { lock, cap } = makeLock();
    const cfg = makeConfig({ lock, loadState: vi.fn().mockRejectedValue(new Error('db down')) });
    await expect(tick(cfg)).rejects.toThrow(/db down/);
    expect(cap.released).toEqual([`lock:agent:${AGENT_ID}`]);
  });
});

describe('tick — lock release safety', () => {
  it('release throw is LOGGED as error (with err object) — does NOT throw out of tick', async () => {
    const logger = makeLogger();
    const { lock, cap } = makeLock({ releaseThrows: new Error('redis disconnect') });
    const result = await tick(makeConfig({ lock, logger }));
    expect(result.kind).toBe('completed');
    expect(cap.released).toEqual([`lock:agent:${AGENT_ID}`]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ lockKey: `lock:agent:${AGENT_ID}`, err: expect.any(Error) }),
      'tick.lock_release_failed',
    );
  });
});

describe('tick — structured logging + tickId correlation', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('same tickId appears in EVERY phase log line + completion', async () => {
    await tick(makeConfig({ logger }));
    const tickIds = new Set<string>();
    const allCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    for (const [obj] of allCalls) {
      const tid = (obj as Record<string, unknown>).tickId;
      if (typeof tid === 'string') tickIds.add(tid);
    }
    expect(tickIds.size).toBe(1);
  });

  it('logs phase error with err object (full stack survives) and cause tag', async () => {
    await tick(
      makeConfig({
        logger,
        simulate: vi.fn().mockResolvedValue(err(new Error('rpc 502'))),
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'simulate',
        err: expect.any(Error),
        cause: 'returned',
      }),
      'tick.phase.error',
    );
  });
});

describe('tick — concurrent same-process safety', () => {
  it('two concurrent tick() calls on same agent: only one acquires; other returns skipped', async () => {
    let held = false;
    const lock: TickLock = {
      async acquire() {
        if (held) return false;
        held = true;
        return true;
      },
      async release() {
        held = false;
      },
    };
    const [r1, r2] = await Promise.all([tick(makeConfig({ lock })), tick(makeConfig({ lock }))]);
    const kinds = [r1.kind, r2.kind].sort();
    expect(kinds).toEqual(['completed', 'skipped']);
  });
});
