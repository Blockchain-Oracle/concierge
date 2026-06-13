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
import { AGENT_ID, makeFakes, makeLock, STATE } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e AbortBetweenPhases — TTL-driven abort halts mid-tick (round-1 coverage gap)', () => {
  it('plan blocks past lockTtlMs - ABORT_MARGIN_MS → tick returns kind:"aborted"; downstream NOT invoked', async () => {
    // lockTtlMs is the smallest value above ABORT_MARGIN_MS (5_000): pick
    // 5_100 so the abort fires ~100ms after lock acquire. `plan` blocks on
    // a deferred we never resolve so the abort wins.
    const fakes = makeFakes();
    // Plan completes AFTER the abort timer has fired (200ms > the 100ms
    // gap between lockTtlMs and ABORT_MARGIN_MS). The orchestrator's
    // BETWEEN-phase checkAborted detects the abort before simulate runs.
    const plan: PlanFn = vi.fn().mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      return {
        kind: 'continue',
        data: { intent: 'rebalance', providerCalls: [] },
      };
    });
    const simulate: SimulateFn = vi.fn();
    const propose: ProposeFn = vi.fn();
    const execute: ExecuteFn = vi.fn();
    const record: RecordFn = vi.fn();

    const config: TickConfig = {
      agentId: AGENT_ID,
      loadState: vi.fn().mockResolvedValue(STATE),
      plan,
      simulate,
      propose,
      execute,
      record,
      lock: makeLock(fakes),
      lockTtlMs: 5_100,
    };
    const result = await tick(config);
    expect(result.kind).toBe('aborted');
    if (result.kind !== 'aborted') throw new Error('expected aborted');
    expect(result.reason).toBe('ttl_exceeded');
    expect(simulate).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(fakes.lockHolders.size).toBe(0); // released on abort
  }, 10_000);
});
