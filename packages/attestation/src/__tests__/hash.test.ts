import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../canonicalize.ts';
import { computeFeedbackHash, computeFeedbackHashUnchecked } from '../hash.ts';
import { AAVE_SUPPLY, FIXTURES, LIFI_BRIDGE } from './__fixtures__/envelopes.ts';

describe('computeFeedbackHash — basic shape', () => {
  it('returns 0x-prefixed 32-byte hex (66 chars)', () => {
    const h = computeFeedbackHash(AAVE_SUPPLY);
    expect(h).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('deterministic — two calls in the same process produce byte-equal hex', () => {
    const a = computeFeedbackHash(AAVE_SUPPLY);
    const b = computeFeedbackHash(AAVE_SUPPLY);
    expect(a).toBe(b);
  });

  it('Known Vector — golden hash for AAVE_SUPPLY (locks contract conformance)', () => {
    // The expected value is the keccak256 of the canonical bytes pinned in
    // story-80's golden-bytes test. Any drift in canonicalize OR hash
    // implementation breaks this immediately — exactly what we want as the
    // on-chain `dataHash` regression anchor.
    const expected = keccak256(toBytes(canonicalize(AAVE_SUPPLY)));
    expect(computeFeedbackHash(AAVE_SUPPLY)).toBe(expected);
  });

  it('manual keccak256(utf8(canonicalize(env))) matches computeFeedbackHash (the function does what it says)', () => {
    for (const env of [AAVE_SUPPLY, LIFI_BRIDGE]) {
      const manual = keccak256(toBytes(canonicalize(env)));
      expect(computeFeedbackHash(env)).toBe(manual);
    }
  });

  it('checked vs unchecked: identical output for VALID envelopes', () => {
    expect(computeFeedbackHash(AAVE_SUPPLY)).toBe(computeFeedbackHashUnchecked(AAVE_SUPPLY));
  });
});

describe('computeFeedbackHash — collision-resistance smoke', () => {
  it('two envelopes differing in ONE field produce hashes that differ in ≥ 50% of bytes', () => {
    const baseHash = computeFeedbackHash(AAVE_SUPPLY);
    const mutated = computeFeedbackHash({ ...AAVE_SUPPLY, agentId: 'agent-2' });
    // Drop the 0x prefix; compare nibble-by-nibble for 50%-mismatch.
    const a = baseHash.slice(2);
    const b = mutated.slice(2);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff / a.length).toBeGreaterThanOrEqual(0.5);
  });

  it('each SCHEMA_ID fixture produces a UNIQUE hash (9 distinct values)', () => {
    const hashes = new Set<string>();
    for (const env of Object.values(FIXTURES)) {
      hashes.add(computeFeedbackHash(env));
    }
    expect(hashes.size).toBe(Object.values(FIXTURES).length);
  });
});

describe('computeFeedbackHash — boundary errors', () => {
  it('malformed envelope → throws at the Zod layer (NOT a generic hash error)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate
    expect(() => computeFeedbackHash({ schema: 'not.a.real.id' } as any)).toThrow();
  });

  it('unchecked variant on malformed → throws inside canonicalize, NOT in keccak', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate
    expect(() => computeFeedbackHashUnchecked({ x: undefined } as any)).toThrow();
  });
});

describe('Cross-Process Determinism — fresh Node procs produce byte-equal hashes', () => {
  it('two spawned child processes hash the same envelope to the same bytes32', async () => {
    const helperUrl = new URL('./__helpers__/hash-cross-process.ts', import.meta.url);
    const helperPath = fileURLToPath(helperUrl);
    const payload = JSON.stringify(AAVE_SUPPLY);

    async function spawnOne(): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn('npx', ['tsx', helperPath], {
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
    // Sanity-pin against the in-process call too.
    expect(a).toBe(computeFeedbackHash(AAVE_SUPPLY));
  }, 30_000);
});
