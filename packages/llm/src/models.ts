import { ConciergeError } from '@concierge/sdk';
import type { LlmCallContext, Model, TickPhase } from './types.ts';

export const MODEL_SONNET: Model = 'claude-sonnet-4-6';
export const MODEL_OPUS: Model = 'claude-opus-4-7';
export const MODEL_HAIKU: Model = 'claude-haiku-4-5-20251001';

/** Static phase → default-model table. The frozen object IS the routing data. */
export const DEFAULT_MODEL_BY_PHASE: Readonly<Record<TickPhase, Model>> = Object.freeze({
  plan: MODEL_SONNET,
  simulate: MODEL_SONNET,
  propose: MODEL_SONNET,
  decide: MODEL_SONNET,
  execute: MODEL_SONNET,
  record: MODEL_HAIKU,
});

/**
 * Phase → Model routing. `decide` escalates to Opus 4.7 ONLY when
 * `ctx.riskFlagged === true` (explicit `=== true` so future widening to
 * `boolean | 'unknown'` cannot silently route every uncertain call to Opus).
 *
 * Throws ConciergeError for JS callers that bypass the TickPhase compile-time
 * guarantee — operators get a typed discriminator, not a plain Error.
 */
export function routeModelForPhase(phase: TickPhase, ctx?: LlmCallContext): Model {
  const base = DEFAULT_MODEL_BY_PHASE[phase];
  if (!base) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] routeModelForPhase: unknown phase '${String(phase)}'.`,
    );
  }
  return phase === 'decide' && ctx?.riskFlagged === true ? MODEL_OPUS : base;
}
