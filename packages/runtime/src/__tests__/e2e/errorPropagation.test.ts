import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTickConfig } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e ErrorPropagation — phase errors halt the tick at the failing phase', () => {
  it('simulate returns kind:"error" → tick errored at phase=simulate; execute + record NOT called', async () => {
    const { run, fakes, config } = buildTickConfig({
      simOutcome: {
        kind: 'error',
        error: new Error('oracle stale'),
        cause: 'returned',
      },
    });
    const result = await run();
    expect(result.kind).toBe('errored');
    if (result.kind !== 'errored') throw new Error('expected errored');
    expect(result.phase).toBe('simulate');
    expect(result.error.message).toContain('oracle stale');
    expect(config.execute).not.toHaveBeenCalled();
    expect(config.record).not.toHaveBeenCalled();
    expect(fakes.executions).toHaveLength(0);
    expect(fakes.lockHolders.size).toBe(0); // lock released even on error
  });

  it('execute throws → tick errored at phase=execute with cause:"thrown"', async () => {
    const { run, config } = buildTickConfig();
    (config.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('bundler timeout'),
    );
    const result = await run();
    expect(result.kind).toBe('errored');
    if (result.kind !== 'errored') throw new Error('expected errored');
    expect(result.phase).toBe('execute');
    expect(result.cause).toBe('thrown');
    expect(config.record).not.toHaveBeenCalled();
  });
});
