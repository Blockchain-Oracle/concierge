import { z } from 'zod';

/** Plan-phase intent literal set. */
export const planIntentSchema = z.enum([
  'noop',
  'rebalance',
  'top_up_reserve',
  'pay_lender',
  'unwind',
]);
export type PlanIntent = z.infer<typeof planIntentSchema>;

const IDENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Descriptive (NOT executable) action shape. Field names match the
 * orchestrator's `Plan.providerCalls[]` shape so `runPlan` passes the
 * array through unchanged (no rename mapping layer).
 */
export const actionDescriptorSchema = z.object({
  provider: z.string().min(1).max(64).regex(IDENT_RE, 'provider must be alphanumeric/_/-'),
  action: z.string().min(1).max(64).regex(IDENT_RE, 'action must be alphanumeric/_/-'),
  /** Free-form args bag. Per-provider schema dispatch lives in story-64 (simulate). */
  args: z.record(z.string(), z.unknown()),
});
export type ActionDescriptor = z.infer<typeof actionDescriptorSchema>;

/**
 * Anti-placeholder denylist. The hypothesis field lands in the ERC-8004
 * attestation as the agent's stated reasoning (ADR-004 verifiability
 * claim) — a placeholder like "TODO" / "[REDACTED]" / "..." passes
 * `min(1)` but corrupts the attestation. Reject loudly.
 */
const HYPOTHESIS_PLACEHOLDER_RE =
  /^(?:\[REDACTED\]|TODO|N\/A|\.{2,}|<[^>]*>|\{\{[^}]*\}\}|placeholder|tbd)$/i;

const hypothesisSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (v) => !HYPOTHESIS_PLACEHOLDER_RE.test(v.trim()),
    'hypothesis must not be a placeholder (TODO/[REDACTED]/.../<...>)',
  );

/**
 * Plan output as a DISCRIMINATED UNION over `intent`. Compile-time
 * narrowing: `if (plan.intent === 'noop') plan.suggestedActions: []`.
 * The cross-field invariant (noop ↔ empty actions) is no longer hidden
 * in a `superRefine` — it's a type-level fact.
 */
const noopVariant = z.object({
  intent: z.literal('noop'),
  hypothesis: hypothesisSchema,
  suggestedActions: z.tuple([]),
});

const actionVariant = z.object({
  intent: z.enum(['rebalance', 'top_up_reserve', 'pay_lender', 'unwind']),
  hypothesis: hypothesisSchema,
  suggestedActions: z.array(actionDescriptorSchema).min(1).max(16),
});

export const planSchema = z.discriminatedUnion('intent', [noopVariant, actionVariant]);
export type LlmPlan = z.infer<typeof planSchema>;
