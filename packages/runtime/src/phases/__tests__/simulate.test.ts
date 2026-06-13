import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, Plan } from '../../types.ts';
import type { ActionSimResult } from '../deltaState.ts';
import {
  type ActionSimulator,
  providerActionKey,
  runSimulate,
  type SimulatorRegistry,
} from '../simulate.ts';

afterEach(() => vi.restoreAllMocks());

const STATE: AgentState = {
  agentId: 'agent-sim',
  userId: 'u',
  chain: 'mantle-sepolia',
  goal: 'idle yield',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};

const HF_BEFORE = 2_000_000_000_000_000_000n;
const HF_FLOOR = 1_500_000_000_000_000_000n;
const USDC = '0xUSDC';

function planOf(...calls: Array<{ provider: string; action: string; args?: unknown }>): Plan {
  return {
    intent: 'rebalance',
    providerCalls: calls.map((c) => ({
      provider: c.provider,
      action: c.action,
      args: (c.args as Record<string, unknown>) ?? {},
    })),
  };
}

function ok(over: Partial<Extract<ActionSimResult, { ok: true }>> = {}): ActionSimResult {
  return {
    ok: true,
    gasUsed: 100_000n,
    balanceDeltas: {},
    debtDeltas: {},
    healthFactorAfter: HF_BEFORE,
    oracleStale: false,
    ...over,
  };
}

function revert(reason = 'r'): ActionSimResult {
  return { ok: false, gasUsed: 50_000n, reason: { kind: 'revert', revertReason: reason } };
}

function oracleStale(): ActionSimResult {
  return { ok: false, gasUsed: 50_000n, reason: { kind: 'oracle-stale' } };
}

function registryOf(entries: Array<[string, ActionSimulator]>): SimulatorRegistry {
  return new Map(entries.map(([k, fn]) => [k as `${string}:${string}`, fn]));
}

/**
 * Assert `out` is a `kind:'continue'` PhaseOutcome with `ok:false` data and
 * return the failed `DetailedSim` for further assertion. Replaces the
 * `if (out.kind === 'continue' && !out.data.ok)` pattern that silently passed
 * when the branch was unreachable (round-2 fix).
 */
function expectFailed(
  out: Awaited<ReturnType<typeof runSimulate>>,
): Extract<Extract<typeof out, { kind: 'continue' }>['data'], { ok: false }> {
  expect(out.kind).toBe('continue');
  if (out.kind !== 'continue') throw new Error('unreachable');
  expect(out.data.ok).toBe(false);
  if (out.data.ok) throw new Error('unreachable');
  return out.data;
}

function expectOk(
  out: Awaited<ReturnType<typeof runSimulate>>,
): Extract<Extract<typeof out, { kind: 'continue' }>['data'], { ok: true }> {
  expect(out.kind).toBe('continue');
  if (out.kind !== 'continue') throw new Error('unreachable');
  expect(out.data.ok).toBe(true);
  if (!out.data.ok) throw new Error('unreachable');
  return out.data;
}

describe('runSimulate — happy path', () => {
  it('single supply returns ok=true with aggregated gas + delta', async () => {
    const sim: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ balanceDeltas: { [USDC]: -100_000_000n }, gasUsed: 250_000n }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply', args: { asset: USDC, amount: '100' } }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') {
      expect(out.data.ok).toBe(true);
      if (out.data.ok) {
        expect(out.data.gasEstimateWei).toBe(250_000n);
        expect(out.data.deltaState.balanceDeltas[USDC]).toBe(-100_000_000n);
        expect(out.data.expectedValueDeltaUsd).toBeNull();
      }
    }
  });

  it('happy path: ok=true ALSO returns kind="continue" (contract pinning)', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(ok());
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(true);
  });

  it('empty providerCalls → ok=true; HF unchanged; deltas empty', async () => {
    const out = await runSimulate({
      preState: STATE,
      plan: planOf(),
      registry: registryOf([]),
      healthFactorBefore: HF_BEFORE,
    });
    if (out.kind === 'continue' && out.data.ok) {
      expect(out.data.deltaState.healthFactorBefore).toBe(HF_BEFORE);
      expect(out.data.deltaState.healthFactorAfter).toBe(HF_BEFORE);
      expect(Object.keys(out.data.deltaState.balanceDeltas)).toEqual([]);
      expect(out.data.gasEstimateWei).toBe(0n);
    }
  });

  it('passes args (null-proto) + signal to each simulator', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(ok());
    await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply', args: { x: 1 } }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    const [, args, signal] = (sim as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect((args as Record<string, unknown>)['x']).toBe(1);
    expect(Object.getPrototypeOf(args)).toBeNull();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('runSimulate — ADR-008 oracle-stale always poisons the tick (round-1 CRITICAL fix)', () => {
  it('SUCCESS with oracleStale:true → ok=false with kind="oracle-stale"', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(ok({ oracleStale: true }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    if (out.kind === 'continue') {
      expect(out.data.ok).toBe(false);
      if (!out.data.ok) expect(out.data.error.kind).toBe('oracle-stale');
    }
  });

  it('FAILURE with oracle-stale reason → SimError.kind="oracle-stale"', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(oracleStale());
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('oracle-stale');
    }
  });
});

describe('runSimulate — domain failures (returned, NOT thrown)', () => {
  it('revert → SimError.kind="revert" with failedAtIndex', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(revert('INSUFFICIENT_LIQUIDITY'));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'borrow' }),
      registry: registryOf([['aave:borrow', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('revert');
      if (out.data.error.kind === 'revert') {
        expect(out.data.error.failedAtIndex).toBe(0);
        expect(out.data.error.revertReason).toContain('INSUFFICIENT_LIQUIDITY');
      }
    }
  });

  it('SHORT-CIRCUITS after first failed action; deltaState reflects ONLY action 0', async () => {
    const sim1: ActionSimulator = vi.fn().mockResolvedValue(revert('r'));
    const sim2: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ balanceDeltas: { [USDC]: 999n } }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }, { provider: 'aave', action: 'borrow' }),
      registry: registryOf([
        ['aave:supply', sim1],
        ['aave:borrow', sim2],
      ]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(sim1).toHaveBeenCalledTimes(1);
    expect(sim2).not.toHaveBeenCalled();
    // sim2's 999n MUST NOT leak into deltaState.
    if (out.kind === 'continue') {
      expect(out.data.deltaState.balanceDeltas[USDC]).toBeUndefined();
    }
  });

  it('healthFactorAfter < floor → SimError.kind="hf-breach"', async () => {
    const sim: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ healthFactorAfter: 1_400_000_000_000_000_000n }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'borrow' }),
      registry: registryOf([['aave:borrow', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('hf-breach');
    }
  });

  it('unknown action → SimError.kind="unknown-action"', async () => {
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'mystery', action: 'doStuff' }),
      registry: registryOf([]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('unknown-action');
    }
  });

  it('per-action gas-overrun → SimError.kind="gas-overrun"', async () => {
    const sim: ActionSimulator = vi.fn().mockResolvedValue(ok({ gasUsed: 40_000_000n }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('gas-overrun');
    }
  });

  it('CUMULATIVE gas-overrun → SimError.kind="plan-gas-overrun"', async () => {
    // 15 actions × 25M each = 375M > 10×30M=300M bound; each under per-action limit.
    const sim: ActionSimulator = vi.fn().mockResolvedValue(ok({ gasUsed: 25_000_000n }));
    const calls = Array.from({ length: 15 }, (_, i) => ({
      provider: 'aave',
      action: `step${i}`,
    }));
    const entries: Array<[string, ActionSimulator]> = calls.map((c) => [
      `${c.provider}:${c.action}`,
      sim,
    ]);
    const out = await runSimulate({
      preState: STATE,
      plan: planOf(...calls),
      registry: registryOf(entries),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(out.data.error.kind).toBe('plan-gas-overrun');
    }
  });

  it('SECURITY: revertReason sanitized (Pimlico apikey URL redacted)', async () => {
    const sim: ActionSimulator = vi
      .fn()
      .mockResolvedValue(revert('revert at https://x/v2/rpc?apikey=FAKE_SIM_KEY'));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    if (out.kind === 'continue' && !out.data.ok && out.data.error.kind === 'revert') {
      expect(out.data.error.revertReason).not.toContain('FAKE_SIM_KEY');
      expect(out.data.error.revertReason).toContain('<redacted>');
    }
  });

  it('SECURITY: full SimError envelope JSON has no leaked key', async () => {
    const sim: ActionSimulator = vi
      .fn()
      .mockResolvedValue(revert('?apikey=FAKE_ENVELOPE_KEY in reason'));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') expect(out.data.ok).toBe(false);
    if (out.kind === 'continue' && !out.data.ok) {
      expect(JSON.stringify(out.data.error)).not.toContain('FAKE_ENVELOPE_KEY');
    }
  });

  it('multi-action: HF threads through last successful action (round-2 coverage)', async () => {
    const sim1: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ healthFactorAfter: 1_900_000_000_000_000_000n }));
    const sim2: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ healthFactorAfter: 1_800_000_000_000_000_000n }));
    const sim3: ActionSimulator = vi
      .fn()
      .mockResolvedValue(ok({ healthFactorAfter: 1_700_000_000_000_000_000n }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf(
        { provider: 'aave', action: 'supply' },
        { provider: 'aave', action: 'borrow' },
        { provider: 'aave', action: 'repay' },
      ),
      registry: registryOf([
        ['aave:supply', sim1],
        ['aave:borrow', sim2],
        ['aave:repay', sim3],
      ]),
      healthFactorBefore: HF_BEFORE,
    });
    const okData = expectOk(out);
    expect(okData.deltaState.healthFactorAfter).toBe(1_700_000_000_000_000_000n);
  });

  it('multi-action ADR-008: oracleStale on action[0] poisons even when action[1] is clean', async () => {
    const sim1: ActionSimulator = vi.fn().mockResolvedValue(ok({ oracleStale: true }));
    const sim2: ActionSimulator = vi.fn().mockResolvedValue(ok({ oracleStale: false }));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }, { provider: 'aave', action: 'borrow' }),
      registry: registryOf([
        ['aave:supply', sim1],
        ['aave:borrow', sim2],
      ]),
      healthFactorBefore: HF_BEFORE,
    });
    const failed = expectFailed(out);
    expect(failed.error.kind).toBe('oracle-stale');
    expect(sim2).not.toHaveBeenCalled();
  });

  it('round-2 CWE-1321: __proto__ token key in balanceDeltas is skipped, not assigned', async () => {
    const malicious: ActionSimulator = vi.fn().mockResolvedValue(
      ok({
        balanceDeltas: Object.assign(Object.create(null), { __proto__: 1n, [USDC]: 5n }),
      }),
    );
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', malicious]]),
      healthFactorBefore: HF_BEFORE,
    });
    const okData = expectOk(out);
    expect(okData.deltaState.balanceDeltas[USDC]).toBe(5n);
    expect(Object.keys(okData.deltaState.balanceDeltas).includes('__proto__')).toBe(false);
  });

  it('SECURITY: revertReason length-capped before sanitize (4096 chars)', async () => {
    const huge = 'x'.repeat(20_000);
    const sim: ActionSimulator = vi.fn().mockResolvedValue(revert(huge));
    const out = await runSimulate({
      preState: STATE,
      plan: planOf({ provider: 'aave', action: 'supply' }),
      registry: registryOf([['aave:supply', sim]]),
      healthFactorBefore: HF_BEFORE,
    });
    if (out.kind === 'continue' && !out.data.ok && out.data.error.kind === 'revert') {
      expect(out.data.error.revertReason.length).toBeLessThanOrEqual(4096);
    }
  });
});
