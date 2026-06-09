// Dedicated test file for the `.catch(() => {})` at createConciergeTools.ts:44
// — proving Node's `unhandledRejection` event is suppressed for the leaked
// Promise that a misbehaving async ProviderToolFactory returns. Split out of
// createConciergeTools.test.ts because (a) the test touches `process.on` /
// `setImmediate` (Node-runtime semantics, not aggregation behavior) and
// (b) the long load-bearing comment kept pushing the parent file past the
// 400-LOC cap (biome `noExcessiveLinesPerFile`).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createConciergeTools } from '../createConciergeTools.ts';
import { tool } from '../tool.ts';
import type { ConciergeAgentLike, ProviderToolFactory } from '../types.ts';

// Minimal local ambient declarations for the two Node globals this test
// touches. The package deliberately avoids `@types/node` — it's
// framework-agnostic and consumed from non-Node adapters too. Declaring
// only what we call keeps typecheck honest without pulling DOM-conflicting
// Node typings in.
declare const process: {
  listeners(event: 'unhandledRejection'): Array<(reason: unknown) => void>;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  removeListener(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
declare const setImmediate: (cb: () => void) => void;

const echo = tool({
  name: 'echo',
  description: 'fixture',
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  invoke: async ({ msg }) => ({ echoed: msg }),
});
void echo;

describe('createConciergeTools — unhandledRejection suppression', () => {
  const agentMainnet: ConciergeAgentLike = { chainId: 5000 };

  it('suppresses Node unhandledRejection for the leaked Promise (no orphan emission)', async () => {
    // Honest test of the `.catch(() => {})` at createConciergeTools.ts:44.
    // Strategy: snapshot listeners, install an object-identity-filtered spy
    // FIRST (before removing the others — narrows the bare-window where any
    // concurrent test's rejection would hit a zero-listener emit), then
    // remove the originals, run the failing factory, drain microtasks +
    // unhandledRejection's next-tick emission. The two `setImmediate` waits
    // are load-bearing: the FIRST drains microtasks queued during the
    // synchronous throw; the SECOND covers the next-tick on which Node
    // actually fires `unhandledRejection` per the rejection-tracking
    // algorithm — collapsing to one drain is a known flakiness source under
    // heavy event-loop load. A positive-control assertion PROVES the
    // harness can detect emission (regression-resistant: if the `.catch` is
    // removed AND the test still passes, the positive control catches it).
    //
    // Object-identity sentinels (vs message-string) are robust against any
    // concurrent test that happens to throw the same string — there's only
    // one `SENTINEL_ERR` / `SENTINEL_CONTROL` reference in this process.
    const SENTINEL_ERR = new Error('unhandledRejection suppression sentinel — DO NOT REUSE');
    const SENTINEL_CONTROL = new Error('unhandledRejection positive-control sentinel');
    const originalListeners = process.listeners('unhandledRejection').slice();
    let sentinelHits = 0;
    let controlHits = 0;
    const spy = (reason: unknown) => {
      if (reason === SENTINEL_ERR) sentinelHits++;
      else if (reason === SENTINEL_CONTROL) controlHits++;
    };
    // Install spy FIRST, then strip vitest's listener — minimizes the
    // bare-window where a zero-listener `unhandledRejection` would slip past.
    process.on('unhandledRejection', spy);
    for (const listener of originalListeners) {
      process.removeListener('unhandledRejection', listener);
    }
    try {
      const asyncBad = (() => Promise.reject(SENTINEL_ERR)) as unknown as ProviderToolFactory;
      expect(() => createConciergeTools(agentMainnet, [asyncBad])).toThrow(/returned a Promise/);

      // Positive control: an unsuppressed rejection MUST hit the spy. If
      // this is silently 0, our setImmediate drain is too short and the
      // sentinelHits === 0 assertion below is vacuously green. The control
      // is the load-bearing regression detector — it catches the case where
      // `.catch(() => {})` is removed AND timing happens to mask the leak.
      void Promise.reject(SENTINEL_CONTROL);

      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));

      expect(sentinelHits).toBe(0); // suppression worked
      expect(controlHits).toBe(1); // harness can detect emission
    } finally {
      process.removeListener('unhandledRejection', spy);
      for (const listener of originalListeners) process.on('unhandledRejection', listener);
    }
  });
});
