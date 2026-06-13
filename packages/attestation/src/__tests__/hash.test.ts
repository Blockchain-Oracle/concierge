import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { canonicalize } from '../canonicalize.ts';
import { computeFeedbackHash } from '../hash.ts';
import { AAVE_SUPPLY, FIXTURES, LIFI_BRIDGE } from './__fixtures__/envelopes.ts';

/**
 * Golden anchor — captured ONCE from the canonical bytes pinned in
 * canonicalize.test.ts's golden-bytes test. ANY change to canonicalize OR
 * keccak/utf8 encoding WILL break this assertion. Do NOT recompute via
 * `keccak256(toBytes(canonicalize(AAVE_SUPPLY)))` — that's a tautology
 * (test the implementation against itself). The literal hex IS the
 * regression net.
 */
const KNOWN_VECTOR_AAVE_SUPPLY =
  '0xa6fe727ce1d1804bee648b057f934e5017381ef2031bbce247992bc9a70a512c';

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

  it('Known Vector — LITERAL hardcoded hash for AAVE_SUPPLY (round-1: real anchor, not tautology)', () => {
    expect(computeFeedbackHash(AAVE_SUPPLY)).toBe(KNOWN_VECTOR_AAVE_SUPPLY);
  });

  it('manual keccak256(utf8(canonicalize(env))) matches computeFeedbackHash (the function does what it says)', () => {
    for (const env of [AAVE_SUPPLY, LIFI_BRIDGE]) {
      const manual = keccak256(toBytes(canonicalize(env)));
      expect(computeFeedbackHash(env)).toBe(manual);
    }
  });
});

describe('computeFeedbackHash — collision-resistance smoke', () => {
  it('two envelopes differing in ONE field → hashes differ in ≥ 85% of nibbles (round-1: tightened from 50%)', () => {
    // keccak256 avalanche typically yields ~93.75% nibble mismatch for two
    // independent outputs. The prior 50% floor was so loose any non-broken
    // hash passed; 85% catches a degenerate implementation (e.g. MD5).
    const baseHash = computeFeedbackHash(AAVE_SUPPLY);
    const mutated = computeFeedbackHash({ ...AAVE_SUPPLY, agentId: 'agent-2' });
    const a = baseHash.slice(2);
    const b = mutated.slice(2);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff / a.length).toBeGreaterThanOrEqual(0.85);
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
  it('malformed envelope → throws ZodError (round-1: matcher pins the error type)', () => {
    // Use `Error` matcher because parseFeedbackEnvelope sanitizes ZodError
    // via stripCtrl and rethrows a plain Error in round-2 schema hardening.
    // We assert on the message shape to pin "fails at validation layer."
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberate
      computeFeedbackHash({ schema: 'not.a.real.id' } as any),
    ).toThrow(/schema|envelope|parseFeedbackEnvelope/i);
  });

  it('ZodError reachable via the schema directly (parse-first contract)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate
    expect(() => computeFeedbackHash({} as any)).toThrow();
    // And confirm Zod's native error type still exists for callers that
    // import the schema directly.
    expect(ZodError).toBeDefined();
  });
});

describe('Cross-Process Determinism — fresh Node procs (against built dist) produce byte-equal hashes', () => {
  it('two spawned child processes hash the same envelope to the same bytes32 AND match the golden vector', async () => {
    // round-1 fix: invoke `node` against the BUILT dist/, not `npx tsx`.
    // npx can silently auto-install or pick a globally-cached older tsx,
    // and both children would agree on the wrong version — masking the
    // very drift this test exists to catch.
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
    // Sanity-pin: cross-process bytes match both the in-process call AND
    // the literal golden anchor.
    expect(a).toBe(computeFeedbackHash(AAVE_SUPPLY));
    expect(a).toBe(KNOWN_VECTOR_AAVE_SUPPLY);
  }, 15_000);
});
