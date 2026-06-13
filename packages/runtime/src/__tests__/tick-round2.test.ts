import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../tick.ts';
import type {
  AgentState,
  Attestation,
  Exec,
  PhaseOutcome,
  Plan,
  Proposal,
  ReleaseOutcome,
  Sim,
  TickConfig,
  TickLock,
  TickLogger,
} from '../types.ts';

afterEach(() => vi.restoreAllMocks());

const AGENT_ID = 'agent-r2';
const SAMPLE_STATE: AgentState = {
  agentId: AGENT_ID,
  userId: 'u',
  chain: 'mantle-sepolia',
  goal: 'g',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};
const PLAN: Plan = { intent: 'plan', providerCalls: [] };
const SIM: Sim = { ok: true, gasEstimateWei: 1n, expectedValueDeltaUsd: 0, warnings: [] };
const PROP: Proposal = { id: 'p', requiresApproval: false, summary: '', txParams: [] };
const EXEC: Exec = { txHashes: [], blockNumbers: [] };
const ATTEST: Attestation = { attestationUid: 'a', recordedAt: new Date() };
const ok = <T>(d: T): PhaseOutcome<T> => ({ kind: 'continue', data: d });

function makeLock(): TickLock {
  return {
    async acquire() {
      return true;
    },
    async release(): Promise<ReleaseOutcome> {
      return 'released';
    },
  };
}

function makeConfig(over: Partial<TickConfig> = {}): TickConfig {
  return {
    agentId: AGENT_ID,
    loadState: vi.fn().mockResolvedValue(SAMPLE_STATE),
    plan: vi.fn().mockResolvedValue(ok(PLAN)),
    simulate: vi.fn().mockResolvedValue(ok(SIM)),
    propose: vi.fn().mockResolvedValue(ok(PROP)),
    execute: vi.fn().mockResolvedValue(ok(EXEC)),
    record: vi.fn().mockResolvedValue(ok(ATTEST)),
    lock: makeLock(),
    ...over,
  };
}

function makeLogger(): TickLogger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('round-2: ConfigError boundaries', () => {
  it('throws ConfigError on lockTtlMs <= ABORT_MARGIN_MS (5000)', async () => {
    await expect(tick(makeConfig({ lockTtlMs: 5000 }))).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'ConfigError' && /MUST exceed/.test(e.message),
    );
  });

  it('JS-boundary defensive check: missing required fn field throws ConfigError', async () => {
    const cfg = makeConfig() as unknown as Record<string, unknown>;
    cfg['plan'] = undefined;
    await expect(tick(cfg as TickConfig)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'ConfigError' && /'plan'/.test(e.message),
    );
  });

  it('rejects malformed lock field (missing acquire)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate malformed
    await expect(tick(makeConfig({ lock: {} as any }))).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'ConfigError' && /'lock'/.test(e.message),
    );
  });
});

describe('round-2: AbortSignal threading + post-phase check', () => {
  it('passes the SAME AbortSignal instance to all 5 phases', async () => {
    const seen: AbortSignal[] = [];
    const cap = (_state: AgentState, _prev: unknown, signal: AbortSignal) => {
      seen.push(signal);
      return ok({} as never);
    };
    const cfg = makeConfig({
      // biome-ignore lint/suspicious/noExplicitAny: per-phase passthrough
      plan: vi.fn(async (s, sig) => (cap(s, null, sig), ok(PLAN)) as any),
      simulate: vi.fn(async (s, _p, sig) => (cap(s, null, sig), ok(SIM)) as any),
      propose: vi.fn(async (s, _p, sig) => (cap(s, null, sig), ok(PROP)) as any),
      execute: vi.fn(async (s, _p, sig) => (cap(s, null, sig), ok(EXEC)) as any),
      record: vi.fn(async (s, _p, sig) => (cap(s, null, sig), ok(ATTEST)) as any),
    });
    await tick(cfg);
    expect(seen).toHaveLength(5);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(seen[4]);
  });

  it('post-phase abort: if plan honors signal then aborts, simulate is NEVER invoked', async () => {
    // Force tiny TTL so the timer fires during plan. ABORT_MARGIN_MS is 5000
    // so we need lockTtlMs > 5000; use 5001 which gives ~1ms before abort.
    const cfg = makeConfig({
      lockTtlMs: 5001,
      plan: vi.fn(async (_s, sig) => {
        // Wait briefly to let the abort timer fire, then ack.
        await new Promise((r) => setTimeout(r, 50));
        if (sig.aborted) return ok(PLAN);
        return ok(PLAN);
      }),
      simulate: vi.fn(),
    });
    const result = await tick(cfg);
    expect(result.kind).toBe('aborted');
    if (result.kind === 'aborted') expect(result.phase).toBe('simulate');
    expect(cfg.simulate).not.toHaveBeenCalled();
  });
});

describe('round-2: Lua nonce-mismatch surfaced', () => {
  it('release "nonce-mismatch" → error-level log', async () => {
    const logger = makeLogger();
    const lock: TickLock = {
      async acquire() {
        return true;
      },
      async release(): Promise<ReleaseOutcome> {
        return 'nonce-mismatch';
      },
    };
    const result = await tick(makeConfig({ lock, logger }));
    expect(result.kind).toBe('completed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID }),
      'tick.lock_release_nonce_mismatch',
    );
  });

  it('release "not-held" → warn log (no-op was unexpected for this path)', async () => {
    const logger = makeLogger();
    const lock: TickLock = {
      async acquire() {
        return true;
      },
      async release(): Promise<ReleaseOutcome> {
        return 'not-held';
      },
    };
    await tick(makeConfig({ lock, logger }));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID }),
      'tick.lock_release_no_nonce',
    );
  });
});

describe('round-2: sanitize cause chain through TickResult', () => {
  it('TickResult.errored.error.cause has NO raw apikey', async () => {
    const inner = new Error('Pimlico 401 at https://api.pimlico.io/v2/mantle?apikey=FAKE_R2_KEY');
    const wrap = new Error('phase wrap', { cause: inner });
    const cfg = makeConfig({
      simulate: vi.fn().mockResolvedValue({ kind: 'error', error: wrap }),
    });
    const result = await tick(cfg);
    if (result.kind === 'errored') {
      let cur: unknown = result.error;
      while (cur instanceof Error) {
        expect(cur.message).not.toContain('FAKE_R2_KEY');
        cur = cur.cause;
      }
    } else {
      throw new Error('expected errored result');
    }
  });

  it('loadState error is sanitized (DB connection-string credential class)', async () => {
    const cfg = makeConfig({
      loadState: vi
        .fn()
        .mockRejectedValue(new Error('connect to postgres://user:FAKE_PW@db/app failed')),
    });
    try {
      await tick(cfg);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('FAKE_PW');
    }
  });
});

describe('round-2: caller sanitizeError throw is contained', () => {
  it('a buggy sanitizeError that throws cannot escape tick boundary', async () => {
    const cfg = makeConfig({
      sanitizeError: () => {
        throw new Error('sanitizer is broken');
      },
      simulate: vi.fn().mockResolvedValue({ kind: 'error', error: new Error('domain') }),
    });
    const result = await tick(cfg);
    expect(result.kind).toBe('errored');
    if (result.kind === 'errored') expect(result.phase).toBe('simulate');
  });
});

describe('round-2: tickId is a UUID', () => {
  it('logger payload tickId matches crypto.randomUUID shape', async () => {
    const logger = makeLogger();
    await tick(makeConfig({ logger }));
    const firstCall = logger.info.mock.calls[0];
    const tid = (firstCall?.[0] as Record<string, unknown>).tickId;
    expect(tid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
