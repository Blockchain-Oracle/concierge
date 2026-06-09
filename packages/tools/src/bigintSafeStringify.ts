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
      (_key, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return Array.from(v);
        // Nested guard fires for everything except the synthetic top-level
        // wrapper call (where v === root). Empty-string keys are caught.
        if (v !== root) {
          if (typeof v === 'function' || typeof v === 'symbol' || isThenable(v)) {
            throw new TypeError(
              `[@concierge/tools] bigintSafeStringify: non-serializable nested ${typeof v === 'object' ? 'thenable/Promise' : typeof v} (forgot to await?)`,
            );
          }
          if (v instanceof WeakMap || v instanceof WeakSet) {
            throw new TypeError(
              '[@concierge/tools] bigintSafeStringify: nested WeakMap/WeakSet is not serializable',
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
  // Engine-level defense: the pre-guards catch every documented case where
  // JSON.stringify returns non-string, but a runtime bug (or a Proxy whose
  // valueOf throws and the engine recovers with undefined) would otherwise
  // violate the `:string` contract silently. Cheap typeof check.
  if (typeof result !== 'string') {
    throw new TypeError(
      `[@concierge/tools] bigintSafeStringify: JSON.stringify returned non-string (${typeof result})`,
    );
  }
  return result;
}
