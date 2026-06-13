/**
 * Deterministic JSON serialization for the feedback envelope.
 *
 * **Contract:** byte output MUST be identical across runs/clients for any
 * input that compares structurally equal. Keys sorted at every level, no
 * whitespace, arrays preserve order. This is the input to `keccak256()`
 * for the on-chain attestation pointer; any drift breaks verification.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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
      // CWE-1321: reject prototype-pollution-ish own-property keys. The
      // hash preimage must never include these (downstream JSON.parse +
      // unsafe merge utilities are a real foot-gun).
      if (FORBIDDEN_KEYS.has(k)) {
        throw new Error(`[@concierge/attestation] canonicalize: forbidden key '${k}' (CWE-1321).`);
      }
      // ROUND-1 FIX: throw on `undefined` object values too. The pre-round
      // behavior silently dropped them, so `{a:1,b:undefined}` and `{a:1}`
      // produced identical canonical bytes → identical keccak → two
      // semantically-different envelopes hashed to the same on-chain
      // pointer. Producers MUST `delete` keys they don't want included.
      if (obj[k] === undefined) {
        throw new Error(
          `[@concierge/attestation] canonicalize: undefined value at key '${k}' — delete the key explicitly.`,
        );
      }
      parts.push(`${JSON.stringify(k)}:${walk(obj[k], seen)}`);
    }
    seen.delete(value);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`[@concierge/attestation] canonicalize: unsupported type ${typeof value}.`);
}
