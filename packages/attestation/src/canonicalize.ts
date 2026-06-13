/**
 * Deterministic JSON serialization for the feedback envelope.
 *
 * **Contract:** byte output MUST be identical across runs/clients for any
 * input that compares structurally equal. Keys sorted at every level, no
 * whitespace, arrays preserve order. This is the input to `keccak256()`
 * for the on-chain attestation pointer; any drift breaks verification.
 *
 * **Round-2 hardening:**
 * - FORBIDDEN_KEYS extended with legacy accessor methods so prototype-
 *   pollution-via-unsafe-merge in downstream consumers cannot ride the
 *   hash preimage (CWE-1321).
 * - DEFAULT_MAX_DEPTH cap (64) prevents pathological-depth DoS (CWE-674).
 * - Object.getOwnPropertyNames + enumerable check covers non-enumerable
 *   own props that Object.keys silently skipped (would diverge the hash
 *   from the visible-to-producer object).
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);
const DEFAULT_MAX_DEPTH = 64;

export interface CanonicalizeOptions {
  readonly maxDepth?: number;
}

export function canonicalize(input: unknown, opts: CanonicalizeOptions = {}): string {
  return walk(input, new WeakSet<object>(), 0, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
}

function walk(value: unknown, seen: WeakSet<object>, depth: number, maxDepth: number): string {
  if (depth > maxDepth) {
    throw new Error(
      `[@concierge/attestation] canonicalize: max depth ${maxDepth} exceeded (CWE-674 guard).`,
    );
  }
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
    const out = `[${value.map((v) => walk(v, seen, depth + 1, maxDepth)).join(',')}]`;
    seen.delete(value);
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('[@concierge/attestation] canonicalize: cyclic input.');
    }
    seen.add(value);
    const obj = value as Record<string, unknown>;
    // Round-2: getOwnPropertyNames surfaces non-enumerable own props that
    // Object.keys silently skips; we then re-check `enumerable` so the
    // hash preimage stays in lockstep with what JSON.parse would round-trip.
    const allNames = Object.getOwnPropertyNames(obj).sort();
    const parts: string[] = [];
    for (const k of allNames) {
      if (FORBIDDEN_KEYS.has(k)) {
        throw new Error(`[@concierge/attestation] canonicalize: forbidden key '${k}' (CWE-1321).`);
      }
      const desc = Object.getOwnPropertyDescriptor(obj, k);
      if (desc === undefined) continue;
      if (!desc.enumerable) {
        throw new Error(
          `[@concierge/attestation] canonicalize: non-enumerable own property '${k}' rejected (would diverge hash from JSON round-trip).`,
        );
      }
      if (desc.get !== undefined) {
        throw new Error(
          `[@concierge/attestation] canonicalize: accessor own property '${k}' rejected.`,
        );
      }
      // Round-1 contract: throw on undefined object values (silent drop would
      // collide two structurally-different envelopes to the same keccak).
      if (obj[k] === undefined) {
        throw new Error(
          `[@concierge/attestation] canonicalize: undefined value at key '${k}' — delete the key explicitly.`,
        );
      }
      parts.push(`${JSON.stringify(k)}:${walk(obj[k], seen, depth + 1, maxDepth)}`);
    }
    seen.delete(value);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`[@concierge/attestation] canonicalize: unsupported type ${typeof value}.`);
}
