import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { canonicalize } from '../canonicalize.ts';
import { computeFeedbackHash, computeFeedbackPair } from '../hash.ts';
import {
  AAVE_SUPPLY,
  FIXTURES,
  GOLDEN_AAVE_SUPPLY_HASH,
  LIFI_BRIDGE,
} from './__fixtures__/envelopes.ts';

describe('computeFeedbackHash — basic shape', () => {
  it('returns 0x-prefixed 32-byte hex (66 chars)', () => {
    const h = computeFeedbackHash(AAVE_SUPPLY);
    expect(h).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('deterministic — two calls in the same process produce byte-equal hex', () => {
    expect(computeFeedbackHash(AAVE_SUPPLY)).toBe(computeFeedbackHash(AAVE_SUPPLY));
  });

  it('Known Vector — central LITERAL golden hash (round-2: single source of truth)', () => {
    expect(computeFeedbackHash(AAVE_SUPPLY)).toBe(GOLDEN_AAVE_SUPPLY_HASH);
  });

  it('manual keccak256(utf8(canonicalize(env))) matches computeFeedbackHash (the function does what it says)', () => {
    for (const env of [AAVE_SUPPLY, LIFI_BRIDGE]) {
      const manual = keccak256(toBytes(canonicalize(env)));
      expect(computeFeedbackHash(env)).toBe(manual);
    }
  });
});

describe('computeFeedbackPair — round-2: returns hash + canonical bytes paired', () => {
  it('returns both fields; hash === keccak256(utf8(canonical)) by construction', () => {
    const { hash, canonical } = computeFeedbackPair(AAVE_SUPPLY);
    expect(hash).toBe(GOLDEN_AAVE_SUPPLY_HASH);
    expect(hash).toBe(keccak256(toBytes(canonical)));
  });

  it('canonical bytes match the canonicalize() output (caller can pin to IPFS without re-canonicalizing)', () => {
    const { canonical } = computeFeedbackPair(AAVE_SUPPLY);
    expect(canonical).toBe(canonicalize(AAVE_SUPPLY));
  });

  it('computeFeedbackHash and computeFeedbackPair.hash are identical for valid envelopes', () => {
    for (const env of Object.values(FIXTURES)) {
      expect(computeFeedbackHash(env)).toBe(computeFeedbackPair(env).hash);
    }
  });
});

describe('computeFeedbackHash — collision-resistance', () => {
  it('two envelopes differing in ONE field → nibble-mismatch in [0.85, 1.0] (round-2: tightened band)', () => {
    const a = computeFeedbackHash(AAVE_SUPPLY).slice(2);
    const b = computeFeedbackHash({ ...AAVE_SUPPLY, agentId: 'agent-2' }).slice(2);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    const ratio = diff / a.length;
    // keccak256 avalanche typically ~93.75% nibble mismatch for two
    // independent outputs. The window catches BOTH degradation below 85%
    // AND nonsense outputs above 1.0 (which would mean a counting bug).
    expect(ratio).toBeGreaterThanOrEqual(0.85);
    expect(ratio).toBeLessThanOrEqual(1.0);
  });

  it('all 9 SCHEMA_ID fixtures produce 9 UNIQUE hashes (literal count pin)', () => {
    const hashes = new Set<string>();
    for (const env of Object.values(FIXTURES)) {
      hashes.add(computeFeedbackHash(env));
    }
    expect(hashes.size).toBe(9);
  });
});

describe('computeFeedbackHash — boundary errors', () => {
  it('malformed envelope → throws at validation layer', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate
      computeFeedbackHash({ schema: 'not.a.real.id' } as any),
    ).toThrow(/parseFeedbackEnvelope|invalid|envelope/i);
  });

  it('round-2: parse-passes-canonicalize-throws (bigint payload survives Zod, dies at canonicalize)', () => {
    // payload is z.unknown() so a bigint survives schema validation, then
    // canonicalize throws because JSON has no bigint primitive. Confirms
    // the error surfaces as a throw rather than a silent "[object Object]"
    // hash that would never match on-chain.
    const env = { ...AAVE_SUPPLY, payload: { amount: 100n } };
    // biome-ignore lint/suspicious/noExplicitAny: bigint in z.unknown() requires cast
    expect(() => computeFeedbackHash(env as any)).toThrow(/bigint/);
  });

  it('ZodError is reachable for callers that import the schema directly', () => {
    expect(ZodError).toBeDefined();
  });
});

describe('Cross-Process Determinism — fresh Node procs (against built dist) produce byte-equal hashes', () => {
  it('two spawned child processes hash the same envelope to the same bytes32 AND match the golden vector', async () => {
    const helperUrl = new URL('./__helpers__/hash-cross-process.mjs', import.meta.url);
    const helperPath = fileURLToPath(helperUrl);
    const payload = JSON.stringify(AAVE_SUPPLY);

    async function spawnOne(): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [helperPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
          out += d.toString();
        });
        child.stderr.on('data', (d) => {
          err += d.toString();
        });
        child.on('exit', (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`child exited ${code}: ${err}`));
        });
        child.stdin.write(payload);
        child.stdin.end();
      });
    }

    const [a, b] = await Promise.all([spawnOne(), spawnOne()]);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[a-f0-9]{64}$/);
    // Triple-anchor: cross-process == in-process == literal golden.
    expect(a).toBe(computeFeedbackHash(AAVE_SUPPLY));
    expect(a).toBe(GOLDEN_AAVE_SUPPLY_HASH);
  }, 15_000);
});
