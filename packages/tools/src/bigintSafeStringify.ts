// JSON.stringify with bigint → decimal-string, Map → object, Set → array.
// Wraps THREE top-level failure modes (pre-stringify guard / JSON.stringify
// throw / post-stringify non-string defense-in-depth) and ALSO refuses to
// silently serialize nested data-corrupting types — function / symbol /
// thenable / WeakMap / WeakSet inside a payload would otherwise emit `{}`
// per JSON.stringify spec, which is data loss with no error.
//
// Nested rejection uses value-identity vs the captured root rather than
// `key !== ''` — empty-string keys (`{ '': … }`) are legal JSON and cannot
// be used as a top-level sentinel.

import { isThenable } from './guards.ts';

/**
 * Recursive shape of values bigintSafeStringify accepts at the type level.
 * Named `JsonSerializable` (NOT `Serializable`) to avoid colliding with the
 * `Serializable*` UI-card namespace (`SerializableTickCard` etc.) that the
 * package barrel also exports from `serializable.ts`.
 *
 * - `bigint` is rewritten to decimal string by the replacer.
 * - `Map<string, V>` is rewritten to a plain object; non-string keys would
 *   be coerced silently by `Object.fromEntries`, so the type pins keys to
 *   string — the runtime accepts any `Map` and the coercion is its problem.
 * - `Set<V>` is rewritten to a JSON array. The transform is one-way (`Set`
 *   semantics — uniqueness, insertion order vs JSON array order — are not
 *   recoverable on parse), so the conversion is *deterministic*, not
 *   *lossless*. Callers needing round-trip integrity should serialize a
 *   plain array directly.
 * - Symbol-keyed properties are dropped per JSON.stringify spec (the
 *   property names, not the values; symbol VALUES at nested positions are
 *   rejected by the replacer with a TypeError — see the file header).
 * - Nested function / symbol / thenable / WeakMap / WeakSet values are
 *   REJECTED (TypeError) by the replacer, NOT silently dropped. The
 *   data-corruption guard is deliberately stricter than JSON.stringify.
 * - Nested `undefined` is dropped per spec (the replacer doesn't reject it
 *   because that path is genuinely lossless — an absent property is the
 *   intended JSON representation).
 *
 * The runtime guards stay as defense-in-depth for callers passing `unknown`;
 * this type is documentation + an opt-in compile-time hint for SDK consumers
 * who want to constrain their payload types ahead of time.
 */
export type JsonSerializable =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly JsonSerializable[]
  | { readonly [k: string]: JsonSerializable }
  | Map<string, JsonSerializable>
  | Set<JsonSerializable>;

export function bigintSafeStringify(value: unknown, space?: number | string): string {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    isThenable(value)
  ) {
    throw new TypeError(
      `[@concierge/tools] bigintSafeStringify: top-level ${typeof value === 'object' ? 'thenable/Promise' : typeof value} is not serializable (violates :string contract)`,
    );
  }

  // Capture root identity so we can distinguish the top-level replacer
  // invocation from any nested call (including legitimately-named '' keys).
  const root = value;

  let result: string | undefined;
  try {
    result = JSON.stringify(
      value,
      (key, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return Array.from(v);
        // Nested guard fires for everything except the synthetic top-level
        // wrapper call (where v === root). Empty-string keys are caught.
        // The `at .${key}` suffix tells the user WHICH field to fix.
        if (v !== root) {
          if (typeof v === 'function' || typeof v === 'symbol' || isThenable(v)) {
            throw new TypeError(
              `[@concierge/tools] bigintSafeStringify: non-serializable nested ${typeof v === 'object' ? 'thenable/Promise' : typeof v} at .${String(key)} (forgot to await?)`,
            );
          }
          if (v instanceof WeakMap || v instanceof WeakSet) {
            throw new TypeError(
              `[@concierge/tools] bigintSafeStringify: nested WeakMap/WeakSet at .${String(key)} is not serializable`,
            );
          }
        }
        return v;
      },
      space,
    );
  } catch (cause) {
    // Pass our typed errors through untouched (already decorated).
    if (cause instanceof TypeError && /\[@concierge\/tools\]/.test(cause.message)) {
      throw cause;
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`[@concierge/tools] bigintSafeStringify: ${msg}`, { cause });
  }
  // Post-stringify guard: JSON.stringify can return the literal `undefined`
  // value (not a string) when the root's `toJSON()` returns undefined — the
  // pre-guards don't catch this because the root IS an object before the
  // SerializeJSONProperty algorithm invokes toJSON. A future engine bug
  // (or a Proxy whose valueOf throws and the engine recovers with undefined)
  // could trip the same branch. Cheap typeof check; tested in
  // bigintSafeStringify.test.ts under "post-stringify guard".
  if (typeof result !== 'string') {
    throw new TypeError(
      `[@concierge/tools] bigintSafeStringify: JSON.stringify returned non-string (${typeof result})`,
    );
  }
  return result;
}
