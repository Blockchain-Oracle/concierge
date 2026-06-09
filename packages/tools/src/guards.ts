// Shared runtime guards used by createConciergeTools + bigintSafeStringify.

import type { z } from 'zod';

/**
 * Tightened Promises/A+ duck-type — requires BOTH `then` AND `catch` as
 * functions. Promises/A+ §1.2 only requires `then`, but a tool payload
 * `{ then: () => 'next-step' }` is legitimately serializable; the stricter
 * check rules out that false positive (real Promises always have `.catch`).
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> & { catch: unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function' &&
    typeof (value as { catch?: unknown }).catch === 'function'
  );
}

/**
 * Duck-type via `_def.type` + `safeParse` rather than `instanceof z.ZodType` —
 * tolerates multiple Zod copies in a monorepo / adapter graph where instanceof
 * checks fail. Relies on Zod 4.x internals; revisit on major bumps.
 */
export function isZodSchema(value: unknown): value is z.ZodType<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const def = (value as { _def?: { type?: unknown } })._def;
  return (
    typeof def === 'object' &&
    def !== null &&
    typeof def.type === 'string' &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * ADR-017: MCP `structuredContent` requires a top-level object. Tools
 * returning scalars must wrap in `z.object({ value: ... })`. Note that
 * `.transform()` / `.pipe()` chains have `_def.type === 'pipe'` — caller
 * should branch on that for a more specific error message.
 */
// biome-ignore lint/suspicious/noExplicitAny: ZodObject's shape param is internal-API; any here lets ZodObject<SpecificShape> satisfy without invariance friction.
export function isZodObject(value: unknown): value is z.ZodObject<any> {
  return (
    isZodSchema(value) && (value as unknown as { _def: { type: string } })._def.type === 'object'
  );
}

/** True iff `value` is a transform/pipe schema (`.transform()` / `.pipe()` chain). */
export function isZodPipe(value: unknown): boolean {
  return (
    isZodSchema(value) && (value as unknown as { _def: { type: string } })._def.type === 'pipe'
  );
}
