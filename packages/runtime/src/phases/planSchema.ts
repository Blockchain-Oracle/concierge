import { z } from 'zod';

/**
 * Plan-phase intent. `noop` is the most common outcome — the agent
 * deliberately chooses to do nothing this tick. The four action intents are
 * the only legal transitions out of plan; each downstream phase
 * (simulate/propose/execute) refines them further but cannot widen the set.
 */
export const planIntentSchema = z.enum([
  'noop',
  'rebalance',
  'top_up_reserve',
  'pay_lender',
  'unwind',
]);
export type PlanIntent = z.infer<typeof planIntentSchema>;

/**
 * Descriptive (NOT executable) action shape returned by the plan phase.
 * The simulate phase converts these to concrete calldata; execute phase
 * actually broadcasts. Plan's job is to say "we should think about
 * doing X via provider Y with these rough args" — narrow string types
 * keep the LLM's output space small.
 */
export const actionDescriptorSchema = z.object({
  providerName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'providerName must be alphanumeric/_/-'),
  actionName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'actionName must be alphanumeric/_/-'),
  /**
   * Free-form args bag. Bounded by total JSON size at the LLM-output
   * boundary — we don't try to enumerate every provider's schema here
   * (that's simulate's job).
   */
  args: z.record(z.string(), z.unknown()),
});
export type ActionDescriptor = z.infer<typeof actionDescriptorSchema>;

/**
 * Full Plan output. `noop` MUST have an empty `suggestedActions` array (the
 * "I chose to do nothing" path); any action intent MUST have ≥1 suggested
 * action. The cross-field invariant is enforced via `.superRefine` so a
 * malformed LLM output (e.g. `intent: 'unwind', suggestedActions: []`) is
 * rejected loudly with a structured error instead of silently coerced.
 */
export const planSchema = z
  .object({
    intent: planIntentSchema,
    hypothesis: z.string().min(1).max(2_000),
    suggestedActions: z.array(actionDescriptorSchema).max(16),
  })
  .superRefine((val, ctx) => {
    if (val.intent === 'noop' && val.suggestedActions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['suggestedActions'],
        message: `intent='noop' MUST carry an empty suggestedActions array.`,
      });
    }
    if (val.intent !== 'noop' && val.suggestedActions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['suggestedActions'],
        message: `intent='${val.intent}' requires at least one suggestedAction.`,
      });
    }
  });
export type LlmPlan = z.infer<typeof planSchema>;
