import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../tick.ts';
import type {
  ExecuteFn,
  PlanFn,
  ProposeFn,
  RecordFn,
  SimulateFn,
  TickConfig,
} from '../../types.ts';
import { AGENT_ID, buildTickConfig, deferred, makeFakes, makeLock, STATE } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e ConcurrentTickGuard — Redis NX lock excludes the second tick (round-1 hardened)', () => {
  it('two ticks for the same agentId WHILE FIRST IS MID-PHASE → second returns kind:"skipped"', async () => {
    // The first tick's `plan` phase blocks on a deferred. The second tick
    // therefore reaches lock.acquire FIRST WAITING — the lock is held by
    // the first tick. Without a true async boundary the fake mocks would
    // resolve synchronously and "race" only via microtask ordering.
    const fakes = makeFakes();
    const planGate = deferred<void>();
    const sharedLock = makeLock(fakes);

    const planA: PlanFn = vi.fn().mockImplementation(async () => {
      await planGate.promise;
      return {
        kind: 'continue',
        data: {
          intent: 'rebalance',
          providerCalls: [{ provider: 'aave', action: 'supply', args: {} }],
        },
      };
    });
    const otherPhases = buildTickConfig({}, fakes);
    const configA: TickConfig = { ...otherPhases.config, lock: sharedLock, plan: planA };

    const planB: PlanFn = vi.fn();
    const simB: SimulateFn = vi.fn();
    const proB: ProposeFn = vi.fn();
    const exeB: ExecuteFn = vi.fn();
    const recB: RecordFn = vi.fn();
    const configB: TickConfig = {
      agentId: AGENT_ID,
      loadState: vi.fn().mockResolvedValue(STATE),
      plan: planB,
      simulate: simB,
      propose: proB,
      execute: exeB,
      record: recB,
      lock: sharedLock,
      lockTtlMs: 60_000,
    };

    // Start A; let its `plan` block. Then start B.
    const aProm = tick(configA);
    await new Promise((r) => setImmediate(r));
    expect(planA).toHaveBeenCalledTimes(1); // A is inside plan, holding the lock
    const bProm = tick(configB);
    const bResult = await bProm;
    // B must have been gated at lock.acquire and returned skipped without
    // entering ANY phase.
    expect(bResult.kind).toBe('skipped');
    expect(planB).not.toHaveBeenCalled();

    // Release A's plan; A finishes; assert exactly one full pipeline ran.
    planGate.resolve();
    const aResult = await aProm;
    expect(aResult.kind).toBe('completed');
    expect(fakes.executions).toHaveLength(1);
    expect(fakes.attestationsAttempted).toHaveLength(1);
    expect(fakes.lockHolders.size).toBe(0);
  });

  it('pre-held lock → tick returns kind:"skipped"; no phases invoked', async () => {
    const { run, fakes, config } = buildTickConfig({ preheldLock: true });
    const result = await run();
    expect(result.kind).toBe('skipped');
    expect(config.plan).not.toHaveBeenCalled();
    expect(fakes.executions).toHaveLength(0);
  });
});
