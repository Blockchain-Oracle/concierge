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
const FORBIDDEN_ARG_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const HYPOTHESIS_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '[redacted]',
  'todo',
  'n/a',
  'placeholder',
  'tbd',
  'fixme',
  'xxx',
]);

const hypothesisSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (v) => !HYPOTHESIS_PLACEHOLDERS.has(v.trim().toLowerCase()),
    'hypothesis must not be a placeholder (TODO/[REDACTED]/TBD/etc.)',
  )
  .refine(
    (v) => !/^<[^>]*>$/.test(v.trim()),
    'hypothesis must not be a bracket-wrapped template marker',
  )
  .refine((v) => !/^\{\{[^}]*\}\}$/.test(v.trim()), 'hypothesis must not be a {{template}} marker')
  .refine((v) => !/^\.{2,}$/.test(v.trim()), 'hypothesis must not be a bare ellipsis');

/** Recursively reject __proto__/constructor/prototype keys (CWE-1321 defense). */
function hasForbiddenKey(obj: unknown, depth = 0): boolean {
  if (depth > 8 || obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((v) => hasForbiddenKey(v, depth + 1));
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_ARG_KEYS.includes(k)) return true;
    if (hasForbiddenKey((obj as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

/**
 * ActionDescriptor field names match `Plan.providerCalls[]` so `runPlan`
 * passes the array through unchanged (no rename layer).
 */
export const actionDescriptorSchema = z.object({
  provider: z.string().min(1).max(64).regex(IDENT_RE, 'provider must be alphanumeric/_/-'),
  action: z.string().min(1).max(64).regex(IDENT_RE, 'action must be alphanumeric/_/-'),
  args: z
    .record(z.string(), z.unknown())
    .refine(
      (a) => !hasForbiddenKey(a),
      'args must not contain __proto__/constructor/prototype keys (prototype pollution defense)',
    ),
});
export type ActionDescriptor = z.infer<typeof actionDescriptorSchema>;

const noopVariant = z.object({
  intent: z.literal('noop'),
  hypothesis: hypothesisSchema,
  suggestedActions: z.tuple([]),
});

const actionVariant = z.object({
  // Derived from the single intent source-of-truth so adding a non-noop
  // intent in one place can't drift the action-variant's allowed set.
  intent: planIntentSchema.exclude(['noop']),
  hypothesis: hypothesisSchema,
  suggestedActions: z.array(actionDescriptorSchema).min(1).max(16),
});

export const planSchema = z.discriminatedUnion('intent', [noopVariant, actionVariant]);
export type LlmPlan = z.infer<typeof planSchema>;
