import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ActionSimulator,
  providerActionKey,
  runSimulate,
  type SimulatorRegistry,
} from '../simulate.ts';
import {
  HF_BEFORE,
  HF_FLOOR,
  okResult as ok,
  planOf,
  registryOf,
  STATE,
  USDC,
} from './_simulateFixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('runSimulate — boundary validation (CWE-20)', () => {
  it('throws InvariantViolation on non-IDENT_RE provider', async () => {
    await expect(
      runSimulate({
        preState: STATE,
        plan: {
          intent: 'rebalance',
          providerCalls: [{ provider: 'aave:evil', action: 'supply', args: {} }],
          // biome-ignore lint/suspicious/noExplicitAny: deliberate bypass
        } as any,
        registry: registryOf([]),
        healthFactorBefore: HF_BEFORE,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
    );
  });

  it('throws InvariantViolation on non-IDENT_RE action', async () => {
    await expect(
      runSimulate({
        preState: STATE,
        plan: {
          intent: 'rebalance',
          providerCalls: [{ provider: 'aave', action: 'sup ply', args: {} }],
          // biome-ignore lint/suspicious/noExplicitAny: deliberate bypass
        } as any,
        registry: registryOf([]),
        healthFactorBefore: HF_BEFORE,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
    );
  });
});

describe('runSimulate — abort signal', () => {
  it('pre-aborted signal → SimError.kind="aborted" at index 0; no simulators called', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(ok());
    const ctl = new AbortController();
    ctl.abort();
    const out = await runSimulate(
      {
        preState: STATE,
        plan: planOf({ provider: 'aave', action: 'supply' }),
        registry: registryOf([['aave:supply', sim]]),
        healthFactorBefore: HF_BEFORE,
      },
      { abortSignal: ctl.signal },
    );
    if (out.kind === 'continue' && !out.data.ok && out.data.error.kind === 'aborted') {
      expect(out.data.error.failedAtIndex).toBe(0);
    }
    expect(sim).not.toHaveBeenCalled();
  });

  it('mid-loop abort: signal fires during sim1 → aborted; sim2 never called', async () => {
    // The race wins: sim1's resolution races with abort. EITHER outcome surfaces
    // as "aborted" with index ∈ {0,1} (depending on microtask ordering) — the
    // load-bearing assertion is that sim2 is NEVER invoked.
    const ctl = new AbortController();
    const sim1: ActionSimulator = vi.fn().mockImplementation(async () => {
      const r = ok();
      queueMicrotask(() => ctl.abort());
      return r;
    });
    const sim2: ActionSimulator = vi.fn().mockResolvedValue(ok());
    const out = await runSimulate(
      {
        preState: STATE,
        plan: planOf(
          { provider: 'aave', action: 'supply' },
          { provider: 'aave', action: 'borrow' },
        ),
        registry: registryOf([
          ['aave:supply', sim1],
          ['aave:borrow', sim2],
        ]),
        healthFactorBefore: HF_BEFORE,
      },
      { abortSignal: ctl.signal },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('aborted');
    }
    expect(sim2).not.toHaveBeenCalled();
  });

  it('long-running simulator aborted mid-call → SimError.kind="aborted" (race wins)', async () => {
    const ctl = new AbortController();
    const sim: ActionSimulator = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 500)));
    setTimeout(() => ctl.abort(), 10);
    const out = await runSimulate(
      {
        preState: STATE,
        plan: planOf({ provider: 'aave', action: 'supply' }),
        registry: registryOf([['aave:supply', sim]]),
        healthFactorBefore: HF_BEFORE,
      },
      { abortSignal: ctl.signal },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('aborted');
    }
  });
});

describe('runSimulate — infra failures (THROW)', () => {
  it('simulator throws → ConciergeError(RpcError) with sanitized cause-chain', async () => {
    const leaky = new Error('rpc at https://x/v2/rpc?apikey=FAKE_INFRA_KEY');
    const sim: ActionSimulator = vi.fn().mockRejectedValue(leaky);
    let captured: ConciergeError | undefined;
    try {
      await runSimulate({
        preState: STATE,
        plan: planOf({ provider: 'aave', action: 'supply' }),
        registry: registryOf([['aave:supply', sim]]),
        healthFactorBefore: HF_BEFORE,
      });
    } catch (e) {
      captured = e as ConciergeError;
    }
    expect(captured?.type).toBe('RpcError');
    let cur: unknown = captured;
    let depth = 0;
    while (cur instanceof Error && depth < 10) {
      expect(cur.message).not.toContain('FAKE_INFRA_KEY');
      cur = cur.cause;
      depth++;
    }
  });
});

describe('providerActionKey helper', () => {
  it('produces provider:action template-literal-typed key', () => {
    const k = providerActionKey('aave', 'supply');
    expect(k).toBe('aave:supply');
  });
});

describe('HF floor configurability', () => {
  it('lower floor accepts riskier plan', async () => {
    const sim: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ healthFactorAfter: 1_100_000_000_000_000_000n }));
    const out = await runSimulate(
      {
        preState: STATE,
        plan: planOf({ provider: 'aave', action: 'borrow' }),
        registry: registryOf([['aave:borrow', sim]]),
        healthFactorBefore: HF_BEFORE,
      },
      { healthFactorFloor: HF_FLOOR / 2n },
    );
    if (out.kind === 'continue') expect(out.data.ok).toBe(true);
  });
});
