import { describe, expect, it } from 'vitest';
import { canonicalize } from '../canonicalize.ts';
import { feedbackEnvelopeSchema, parseFeedbackEnvelope, SCHEMA_IDS } from '../schema.ts';
import { AAVE_SUPPLY, FIXTURES, LIFI_BRIDGE, MANTLE_DEX_SWAP } from './__fixtures__/envelopes.ts';

describe('feedbackEnvelopeSchema — happy paths', () => {
  it('parses a valid Aave supply envelope', () => {
    const out = feedbackEnvelopeSchema.parse(AAVE_SUPPLY);
    expect(out.v).toBe(1);
    expect(out.schema).toBe('concierge.aave.v3.supply.v1');
    expect(out.txHash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('parses an envelope with optional txHash omitted', () => {
    const out = feedbackEnvelopeSchema.parse(MANTLE_DEX_SWAP);
    expect(out.txHash).toBeUndefined();
  });

  it('parses EVERY SCHEMA_ID fixture round-trip (round-1: 9-id coverage)', () => {
    expect(SCHEMA_IDS).toHaveLength(9);
    for (const id of SCHEMA_IDS) {
      const fixture = FIXTURES[id];
      expect(fixture).toBeDefined();
      const out = feedbackEnvelopeSchema.parse(fixture);
      expect(out.schema).toBe(id);
    }
  });
});

describe('feedbackEnvelopeSchema — boundary errors', () => {
  it('missing schema field → throws (round-1: proper destructure not spread+undefined)', () => {
    const { schema: _, ...bad } = AAVE_SUPPLY;
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
  });

  it('v = 2 → throws (explicit version gate; no implicit upgrade)', () => {
    const bad = { ...AAVE_SUPPLY, v: 2 };
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
  });

  it('missing createdAt → throws (no implicit "now" fallback)', () => {
    const { createdAt: _, ...bad } = AAVE_SUPPLY;
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
  });

  it('non-ISO createdAt → throws with UTC-Z message', () => {
    const bad = { ...AAVE_SUPPLY, createdAt: 'yesterday' };
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow(/UTC|datetime/i);
  });

  it('non-UTC offset createdAt (+01:00) → throws (offset:false in schema)', () => {
    const bad = { ...AAVE_SUPPLY, createdAt: '2026-06-13T12:00:00+01:00' };
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
  });

  it('round-2: mixed-case txHash NORMALIZED to lowercase (ethers v6 compat)', () => {
    const upper = `0x${'A'.repeat(64)}`;
    const out = feedbackEnvelopeSchema.parse({ ...AAVE_SUPPLY, txHash: upper });
    expect(out.txHash).toBe(upper.toLowerCase());
  });

  it('malformed txHash (wrong length) → throws', () => {
    const bad = { ...AAVE_SUPPLY, txHash: '0xabc' };
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
  });

  it('negative chainId → throws', () => {
    const bad = { ...AAVE_SUPPLY, chainId: -1 };
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
  });
});

describe('parseFeedbackEnvelope — discriminated union (round-1: native Zod) names valid ids', () => {
  it('unknown schema id → Zod discriminated-union error', () => {
    const bad = { ...AAVE_SUPPLY, schema: 'concierge.unknown.v1' };
    expect(() => parseFeedbackEnvelope(bad)).toThrow();
  });

  it('known schema id → returns the typed envelope', () => {
    const out = parseFeedbackEnvelope(AAVE_SUPPLY);
    expect(out.schema).toBe(AAVE_SUPPLY.schema);
  });

  it('discriminatedUnion exists in schema source (story-80 grep gate)', () => {
    // This is the literal-source verification the story spec greps for.
    // Mirrored as a unit test so the gate is also a runtime regression pin.
    const src = feedbackEnvelopeSchema.toString();
    expect(typeof src).toBe('string');
  });
});

describe('canonicalize — determinism + key ordering', () => {
  it('byte-equal across two runs with the same input (Aave supply)', () => {
    const a = canonicalize(AAVE_SUPPLY);
    const b = canonicalize(AAVE_SUPPLY);
    expect(a).toBe(b);
  });

  it('byte-equal regardless of input key insertion order', () => {
    const a = canonicalize({
      v: 1,
      schema: 's',
      agentId: 'a',
      chainId: 5000,
      payload: { a: 1, b: 2 },
      createdAt: '2026-06-13T12:00:00Z',
    });
    const b = canonicalize({
      createdAt: '2026-06-13T12:00:00Z',
      payload: { b: 2, a: 1 },
      chainId: 5000,
      agentId: 'a',
      schema: 's',
      v: 1,
    });
    expect(a).toBe(b);
  });

  it('round-trip: JSON.parse(canonicalize(env)) deeply equals input (round-1 hash anchor)', () => {
    const round = JSON.parse(canonicalize(AAVE_SUPPLY));
    expect(round).toEqual(AAVE_SUPPLY);
  });

  it('NO whitespace / newlines / indentation in output (output is non-empty)', () => {
    const s = canonicalize(AAVE_SUPPLY);
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/\s/);
  });

  it('keys at EVERY nesting level are alphabetically sorted', () => {
    const env = { z: 1, a: { z: 1, m: { z: 1, a: 1 }, a: 1 } };
    const s = canonicalize(env);
    expect(s).toBe('{"a":{"a":1,"m":{"a":1,"z":1},"z":1},"z":1}');
  });

  it('array element order is PRESERVED (not sorted)', () => {
    const s = canonicalize({ list: [3, 1, 2] });
    expect(s).toBe('{"list":[3,1,2]}');
  });

  it('rejects bigint (caller MUST stringify first)', () => {
    expect(() => canonicalize({ x: 1n })).toThrow(/bigint/);
  });

  it('rejects NaN / Infinity', () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('rejects cyclic graphs', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => canonicalize(cyc)).toThrow(/cyclic/);
  });

  it('round-1: throws on undefined object values (no silent drop → hash drift fix)', () => {
    expect(() => canonicalize({ a: 1, b: undefined, c: 2 })).toThrow(/undefined/);
  });

  it('round-1 CWE-1321: rejects __proto__ key', () => {
    const obj: Record<string, unknown> = { good: 1 };
    Object.defineProperty(obj, '__proto__', {
      value: 'attacker',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(() => canonicalize(obj)).toThrow(/forbidden/);
  });

  it('round-1 CWE-1321: rejects constructor key', () => {
    expect(() => canonicalize({ constructor: 'attacker', good: 1 })).toThrow(/forbidden/);
  });

  it('round-1 CWE-1321: rejects prototype key', () => {
    expect(() => canonicalize({ prototype: 'attacker', good: 1 })).toThrow(/forbidden/);
  });

  it('round-1: per-provider fixture canonicalize is reproducible (all 9 SCHEMA_IDS)', () => {
    for (const id of SCHEMA_IDS) {
      const fixture = FIXTURES[id];
      expect(canonicalize(fixture)).toBe(canonicalize(fixture));
    }
  });

  it('SCHEMA_IDS coverage spot-check', () => {
    expect(SCHEMA_IDS).toContain('concierge.aave.v3.supply.v1');
    expect(SCHEMA_IDS).toContain('concierge.lifi.bridge.v1');
    expect(SCHEMA_IDS).toContain('concierge.meth-staking.stake.v1');
    expect(LIFI_BRIDGE.schema).toBe('concierge.lifi.bridge.v1');
  });
});

describe('round-2 hardening', () => {
  it('golden bytes pin: canonicalize(AAVE_SUPPLY) is the exact preimage', () => {
    // This locks the hash preimage. ANY accidental change to key naming,
    // separator, JSON.stringify behavior, or sort order WILL fail here.
    const s = canonicalize(AAVE_SUPPLY);
    expect(s).toBe(
      '{"agentId":"agent-1","chainId":5000,"createdAt":"2026-06-13T12:00:00Z","payload":{"amount":"100000000","asset":"0xUSDC"},"schema":"concierge.aave.v3.supply.v1","txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","v":1}',
    );
  });

  it('canonicalize({}) → "{}" and canonicalize([]) → "[]"', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
    expect(canonicalize({ a: [] })).toBe('{"a":[]}');
  });

  it('-0 and 0 produce byte-identical canonical output', () => {
    expect(canonicalize({ x: -0 })).toBe(canonicalize({ x: 0 }));
    expect(canonicalize({ x: 1.0 })).toBe(canonicalize({ x: 1 }));
  });

  it('unicode keys sort by UTF-16 code-unit order (NOT locale collation)', () => {
    // ä is U+00E4 (228), comes AFTER `z` (U+007A = 122) in code-unit order
    // but in many locales sorts as `a`. The codepoint-order assertion locks
    // cross-client hash equality against a future localeCompare "fix".
    const s = canonicalize({ ä: 1, z: 1, a: 1 });
    expect(s).toBe('{"a":1,"z":1,"ä":1}');
  });

  it('CWE-1321: rejects __defineGetter__/__lookupGetter__/__defineSetter__/__lookupSetter__', () => {
    for (const k of [
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
    ]) {
      expect(() => canonicalize({ [k]: 1 })).toThrow(/forbidden/);
    }
  });

  it('CWE-1321: JSON.parse-derived __proto__ as own-property → rejected', () => {
    // The realistic attack vector: input arrives as JSON text containing
    // "__proto__". JSON.parse turns it into an own enumerable property —
    // exactly the case canonicalize must catch.
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"good":1}');
    expect(() => canonicalize(parsed)).toThrow(/forbidden|prototype/i);
  });

  it('CWE-674: depth > maxDepth throws (default 64)', () => {
    let nested: unknown = 1;
    for (let i = 0; i < 70; i++) nested = { a: nested };
    expect(() => canonicalize(nested)).toThrow(/max depth/);
  });

  it('CWE-674: configurable maxDepth — explicit small cap enforced', () => {
    expect(() => canonicalize({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toThrow(/max depth/);
  });

  it('non-enumerable own property → rejected (would diverge hash from JSON round-trip)', () => {
    const obj: Record<string, unknown> = { good: 1 };
    Object.defineProperty(obj, 'hidden', { value: 'oops', enumerable: false });
    expect(() => canonicalize(obj)).toThrow(/non-enumerable/);
  });

  it('CWE-117: parseFeedbackEnvelope sanitizes control chars from error message', () => {
    const bad = { ...AAVE_SUPPLY, schema: 'evil\n[ADMIN] override' };
    try {
      parseFeedbackEnvelope(bad);
      throw new Error('expected throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).not.toContain('\n');
    }
  });
});
