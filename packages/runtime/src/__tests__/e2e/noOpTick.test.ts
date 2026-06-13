import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTickConfig } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e NoOpTick — plan returns stop early; downstream phases NOT invoked', () => {
  it('plan stop:"noop" → tick stops; execute/record skipped; no executions row', async () => {
    const { run, fakes, config } = buildTickConfig({
      planOutcome: { kind: 'stop', reason: 'noop' },
    });
    const result = await run();
    expect(result.kind).toBe('stopped');
    if (result.kind !== 'stopped') throw new Error('expected stopped');
    expect(result.phase).toBe('plan');
    expect(result.reason).toBe('noop');
    expect(config.plan).toHaveBeenCalledTimes(1);
    expect(config.simulate).not.toHaveBeenCalled();
    expect(config.propose).not.toHaveBeenCalled();
    expect(config.execute).not.toHaveBeenCalled();
    expect(config.record).not.toHaveBeenCalled();
    expect(fakes.executions).toHaveLength(0);
    expect(fakes.attestationsAttempted).toHaveLength(0);
    expect(fakes.lockHolders.size).toBe(0); // lock released even on stop
  });
});
