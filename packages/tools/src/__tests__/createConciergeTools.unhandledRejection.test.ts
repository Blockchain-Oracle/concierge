// Dedicated test file for the `.catch(() => {})` at createConciergeTools.ts:44
// — proving Node's `unhandledRejection` event is suppressed for the leaked
// Promise that a misbehaving async ProviderToolFactory returns. Split out of
// createConciergeTools.test.ts because (a) the test touches `process.on` /
// `setImmediate` (Node-runtime semantics, not aggregation behavior) and
// (b) the long load-bearing comment kept pushing the parent file past the
// 400-LOC cap (biome `noExcessiveLinesPerFile`).

import { describe, expect, it } from 'vitest';
import { createConciergeTools } from '../createConciergeTools.ts';
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

describe('createConciergeTools — unhandledRejection suppression', () => {
  const agentMainnet: ConciergeAgentLike = { chainId: 5000 };

  it('suppresses Node unhandledRejection for the leaked Promise (no orphan emission)', async () => {
    // Honest test of the `.catch(() => {})` at createConciergeTools.ts:44.
    // Strategy: install an object-identity-filtered spy FIRST (narrows the
    // bare-window where a concurrent rejection hits a zero-listener emit),
    // then remove vitest's listeners, run the failing factory, and drain
    // microtasks + unhandledRejection's next-tick emission. The two
    // `setImmediate` waits are load-bearing: the first drains microtasks
    // queued during the synchronous throw; the second covers the next tick
    // on which Node actually fires `unhandledRejection` — collapsing to one
    // drain is a known flakiness source under heavy event-loop load.
    // Object-identity sentinels (vs message strings) can't collide with a
    // concurrent test throwing the same text, and the positive control
    // PROVES the harness can detect emission — if the `.catch` is removed
    // and timing masks the leak, the control catches the vacuous pass.
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
