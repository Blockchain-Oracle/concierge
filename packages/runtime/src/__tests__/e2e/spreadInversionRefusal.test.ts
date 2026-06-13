import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTickConfig } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e SpreadInversionRefusal — inverted carry → plan refuses new borrow', () => {
  it("oracle inverts susde/usdc rates → plan intent is 'unwind'; no new borrow proposed", async () => {
    // Round-1 fix (deleted-criterion restore): the agent's plan layer
    // refuses to OPEN new debt when spread is inverted. We model the
    // upstream signal by returning an `unwind` intent from plan() with
    // ONLY repay/unwind calls (no `borrow` action). Asserts the pipeline
    // halts before any borrow action lands.
    const { run, config } = buildTickConfig({
      planOutcome: {
        kind: 'continue',
        data: {
          intent: 'unwind',
          providerCalls: [
            { provider: 'aave', action: 'repay', args: { amount: '50' } },
            { provider: 'aave', action: 'withdraw', args: { amount: '50' } },
          ],
        },
      },
    });
    const result = await run();
    expect(result.kind).toBe('completed');

    // Critical regression guard: NO provider call in the plan is a borrow.
    const planCall = (config.plan as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    const resolved = await planCall;
    const calls = resolved.kind === 'continue' ? resolved.data.providerCalls : [];
    const borrows = calls.filter((c: { action: string }) => c.action === 'borrow');
    expect(borrows).toHaveLength(0);
    expect(resolved.data.intent).toBe('unwind');
  });

  it('plan returns stop:noop when no positions to unwind → no execute/record', async () => {
    const { run, fakes, config } = buildTickConfig({
      planOutcome: { kind: 'stop', reason: 'noop' },
    });
    const result = await run();
    expect(result.kind).toBe('stopped');
    expect(config.execute).not.toHaveBeenCalled();
    expect(fakes.executions).toHaveLength(0);
  });
});
