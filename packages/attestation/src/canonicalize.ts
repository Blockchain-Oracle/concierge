/**
 * Deterministic JSON serialization for the feedback envelope.
 *
 * **Contract:** the byte output MUST be identical across runs / clients for
 * any input that compares structurally equal — keys sorted at every nesting
 * level, no whitespace, no indentation, no newlines. This is the input to
 * `keccak256()` for the on-chain attestation pointer; any drift breaks
 * verification.
 *
 * - String / number / boolean / null → JSON.stringify (handles escapes).
 * - Array → preserve element order; each element canonicalized.
 * - Plain object → keys sorted alphabetically; each value canonicalized.
 * - bigint → throws (caller MUST stringify before passing in; JSON has no
 *   bigint primitive and silent number coercion would lose precision).
 * - undefined / function / symbol → throws (no valid JSON encoding).
 * - cyclic graphs → throws (would JSON.stringify-loop otherwise).
 */
export function canonicalize(input: unknown): string {
  return walk(input, new WeakSet<object>());
}

function walk(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        '[@concierge/attestation] canonicalize: NaN/Infinity not representable in JSON.',
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') {
    throw new Error(
      '[@concierge/attestation] canonicalize: bigint cannot be encoded; stringify before passing in.',
    );
  }
  if (typeof value === 'undefined') {
    throw new Error('[@concierge/attestation] canonicalize: undefined is not valid JSON.');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`[@concierge/attestation] canonicalize: ${typeof value} is not valid JSON.`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('[@concierge/attestation] canonicalize: cyclic input.');
    }
    seen.add(value);
    const out = `[${value.map((v) => walk(v, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('[@concierge/attestation] canonicalize: cyclic input.');
    }
    seen.add(value);
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      // Skip undefined values (matches JSON.stringify behavior for object
      // fields, where `undefined` is dropped). Throwing here would break
      // round-tripping JSON-shaped data through the canonicalizer.
      if (obj[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${walk(obj[k], seen)}`);
    }
    seen.delete(value);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`[@concierge/attestation] canonicalize: unsupported type ${typeof value}.`);
}
