// JSON.stringify with bigint → decimal-string, Map → object, Set → array.
// Wraps THREE failure modes:
//  - top-level non-serializable values throw before stringify (function / Symbol /
//    undefined / thenable — all would otherwise return value `undefined`, violating
//    the `:string` contract);
//  - JSON.stringify failures (e.g. circular refs) are decorated with tool-context;
//  - a post-stringify guard catches any future replacer change that lets
//    `undefined` escape (defense-in-depth).
// Plus a nested-value guard: a tool that forgot to `await` and returns
// `{ data: Promise.resolve(...) }` would silently emit `{"data":{}}` per JSON
// spec — data corruption. We throw on nested Promise/function/Symbol/WeakMap/
// WeakSet too, so the failure is loud at the boundary, not silent in MCP.

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

  let result: string | undefined;
  try {
    result = JSON.stringify(
      value,
      (key, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return Array.from(v);
        // Catch nested data-corrupting types (would otherwise become {} or drop).
        // WeakMap/WeakSet are also covered by `instanceof` to fail loud rather
        // than silently emit {}.
        if (key !== '') {
          if (typeof v === 'function' || typeof v === 'symbol' || isThenable(v)) {
            throw new TypeError(
              `[@concierge/tools] bigintSafeStringify: non-serializable nested ${typeof v === 'object' ? 'thenable/Promise' : typeof v} at .${key} (forgot to await?)`,
            );
          }
          if (v instanceof WeakMap || v instanceof WeakSet) {
            throw new TypeError(
              `[@concierge/tools] bigintSafeStringify: WeakMap/WeakSet at .${key} is not serializable`,
            );
          }
        }
        return v;
      },
      space,
    );
  } catch (cause) {
    // Pass our own typed errors through untouched (they're already decorated).
    if (cause instanceof TypeError && /\[@concierge\/tools\]/.test(cause.message)) {
      throw cause;
    }
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`[@concierge/tools] bigintSafeStringify: ${msg}`, { cause });
  }
  if (typeof result !== 'string') {
    throw new TypeError(
      `[@concierge/tools] bigintSafeStringify: JSON.stringify returned non-string (${typeof result})`,
    );
  }
  return result;
}
