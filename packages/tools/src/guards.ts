// Shared runtime guards. Each predicate is honest about what it narrows:
// nothing here returns bare `boolean` where TS could flow-narrow downstream.

import type { z } from 'zod';

/**
 * Tightened Promises/A+ duck-type — requires BOTH `then` AND `catch` as
 * functions. Promises/A+ §1.2 defines a thenable as anything with a `then`
 * method, but the spec never requires `catch`; real Promises always have
 * `.catch` via `Promise.prototype`. Requiring both rules out the
 * legitimate-payload false positive `{ then: () => 'x' }` (LLM tool output
 * where `then` happens to be a function value) without rejecting any real
 * Promise. Property accesses are wrapped in try/catch so a throwing getter
 * (RxJS observables, MobX proxies) yields `false` rather than propagating
 * past the serialization boundary. Note: the guard returns false on a
 * throwing getter but can NOT cancel the getter's side effects (logs,
 * metrics, network calls); callers passing untrusted Proxies should
 * sanitize first.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    const v = value as { then?: unknown; catch?: unknown };
    return typeof v.then === 'function' && typeof v.catch === 'function';
  } catch {
    return false;
  }
}

/**
 * Private helper — safely read `_def.type` from a duck-typed Zod-like value.
 * Centralizes the Zod-internals cast so a Zod 5 rename touches one site.
 * Wrapped in try/catch symmetric to `isThenable`: a Proxy/getter that throws
 * during property access (MobX observables, RxJS proxies, malicious schemas)
 * yields `undefined` instead of aborting the registry build with a confusing
 * cross-library stack. The existing `[@concierge/tools] ... must be Zod`
 * error then fires at the call site.
 */
function getZodDefType(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const def = (value as { _def?: { type?: unknown } })._def;
    if (def === null || typeof def !== 'object') return undefined;
    return typeof def.type === 'string' ? def.type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Duck-type via `_def.type` + `safeParse` rather than `instanceof z.ZodType` —
 * tolerates multiple Zod copies in a monorepo / adapter graph where
 * `instanceof` checks fail across realm boundaries. Relies on Zod 4.x
 * internals (`_def.type` discriminant); revisit on a Zod major bump.
 */
export function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    getZodDefType(value) !== undefined &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * ADR-017: MCP `structuredContent` requires a top-level object. Tools
 * returning scalars must wrap in `z.object({ value: ... })`. `.transform()`
 * / `.pipe()` chains have `_def.type === 'pipe'` — callers should branch
 * on `isZodPipe` first for a more specific error message.
 *
 * The `z.ZodRawShape` generic in the narrowing is nominal — duck-typing
 * cannot determine the actual property shape at runtime, only that the
 * value is *some* `z.ZodObject`. Callers needing the precise field types
 * should re-parse with the concrete schema.
 */
export function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return isZodSchema(value) && getZodDefType(value) === 'object';
}

/** True iff `value` is a transform/pipe schema (`.transform()` / `.pipe()` chain). */
export function isZodPipe(value: unknown): value is z.ZodTypeAny {
  return isZodSchema(value) && getZodDefType(value) === 'pipe';
}
