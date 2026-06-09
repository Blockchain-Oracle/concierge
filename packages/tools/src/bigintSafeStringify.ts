// JSON.stringify with bigint → decimal-string, Map → object, Set → array. Native
// JSON.stringify already throws on circular refs; we wrap that throw with a
// tool-context error. Shared-reference DAGs serialize normally (no false positives).
// Spec-defined drops (Symbol, function, undefined-valued props) are NOT recovered.

export function bigintSafeStringify(value: unknown, space?: number | string): string {
  if (value === undefined) {
    throw new TypeError(
      '[@concierge/tools] bigintSafeStringify: top-level value is undefined; JSON.stringify(undefined) returns the value undefined (not the string), which violates the `: string` return contract',
    );
  }
  try {
    return JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return Array.from(v);
        return v;
      },
      space,
    );
  } catch (cause) {
    throw new Error(
      `[@concierge/tools] bigintSafeStringify: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}
