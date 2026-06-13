import { describe, expect, it } from 'vitest';
import { canonicalize } from '../canonicalize.ts';
import { feedbackEnvelopeSchema, parseFeedbackEnvelope, SCHEMA_IDS } from '../schema.ts';
import { AAVE_SUPPLY, LIFI_BRIDGE, MANTLE_DEX_SWAP } from './__fixtures__/envelopes.ts';

describe('feedbackEnvelopeSchema — happy paths', () => {
  it('parses a valid Aave supply envelope', () => {
    const out = feedbackEnvelopeSchema.parse(AAVE_SUPPLY);
    expect(out.v).toBe(1);
    expect(out.schema).toBe('concierge.aave.v3.supply.v1');
    expect(out.txHash).toMatch(/^0x[a-f0-9]{64}$/i);
  });

  it('parses an envelope with optional txHash omitted', () => {
    const out = feedbackEnvelopeSchema.parse(MANTLE_DEX_SWAP);
    expect(out.txHash).toBeUndefined();
  });

  it('parses each per-provider fixture without throwing', () => {
    for (const env of [AAVE_SUPPLY, MANTLE_DEX_SWAP, LIFI_BRIDGE]) {
      expect(() => feedbackEnvelopeSchema.parse(env)).not.toThrow();
    }
  });
});

describe('feedbackEnvelopeSchema — boundary errors', () => {
  it('missing schema field → throws', () => {
    const bad = { ...AAVE_SUPPLY, schema: undefined };
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

  it('non-ISO createdAt → throws', () => {
    const bad = { ...AAVE_SUPPLY, createdAt: 'yesterday' };
    expect(() => feedbackEnvelopeSchema.parse(bad)).toThrow();
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

describe('parseFeedbackEnvelope — discriminator error message names the unknown id', () => {
  it('unknown schema id → error message includes the bad id (NOT a generic Zod error)', () => {
    const bad = { ...AAVE_SUPPLY, schema: 'concierge.unknown.v1' };
    expect(() => parseFeedbackEnvelope(bad)).toThrow(/concierge\.unknown\.v1/);
  });

  it('known schema id → returns the typed envelope', () => {
    const out = parseFeedbackEnvelope(AAVE_SUPPLY);
    expect(out.schema).toBe(AAVE_SUPPLY.schema);
  });

  it('SCHEMA_IDS includes the seven core providers + erc8004 absent (intentional)', () => {
    expect(SCHEMA_IDS).toContain('concierge.aave.v3.supply.v1');
    expect(SCHEMA_IDS).toContain('concierge.lifi.bridge.v1');
    expect(SCHEMA_IDS).toContain('concierge.meth-staking.stake.v1');
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

  it('NO whitespace / newlines / indentation in output', () => {
    const s = canonicalize(AAVE_SUPPLY);
    expect(s).not.toMatch(/\s/);
  });

  it('keys at EVERY nesting level are alphabetically sorted', () => {
    const env = {
      z: 1,
      a: { z: 1, m: { z: 1, a: 1 }, a: 1 },
    };
    const s = canonicalize(env);
    // Each opening brace's first key should be the alphabetically lowest.
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

  it('drops undefined object values (matches JSON.stringify semantics)', () => {
    const s = canonicalize({ a: 1, b: undefined, c: 2 });
    expect(s).toBe('{"a":1,"c":2}');
  });
});
