import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pinFeedback } from '../pin.ts';
import type { PinService } from '../pinService.ts';
import { AAVE_SUPPLY, GOLDEN_AAVE_SUPPLY_HASH } from './__fixtures__/envelopes.ts';

afterEach(() => vi.restoreAllMocks());

const VALID_CIDV1_A = 'bafybeibq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';
const VALID_CIDV1_B = 'bafybeicq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';
const VALID_CIDV1_C = 'bafybeidq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';

function fakePin(
  name: 'pinata' | string,
  cid: string,
): PinService & { calls: number; lastSignal: AbortSignal | undefined } {
  let calls = 0;
  let lastSignal: AbortSignal | undefined;
  return {
    name,
    get calls() {
      return calls;
    },
    get lastSignal() {
      return lastSignal;
    },
    async pin({ signal }) {
      calls += 1;
      lastSignal = signal;
      return { cid, pinId: `${name}:${cid}` };
    },
  };
}

function failingPin(name: 'pinata' | string, msg: string): PinService {
  return {
    name,
    async pin() {
      throw new Error(msg);
    },
  };
}

describe('pinFeedback — happy paths', () => {
  it('both services succeed with SAME CID → no divergence; primary wins; both run', async () => {
    const pinata = fakePin('pinata', VALID_CIDV1_A);
    const w3s = fakePin('w3s-backup', VALID_CIDV1_A);
    const result = await pinFeedback(AAVE_SUPPLY, { primary: pinata, fallback: w3s });
    expect(result.cid).toBe(VALID_CIDV1_A);
    expect(result.hash).toBe(GOLDEN_AAVE_SUPPLY_HASH);
    expect(result.primary.ok).toBe(true);
    expect(result.fallback.ok).toBe(true);
    expect(result.cidDivergence).toBe(false);
    expect(pinata.calls).toBe(1);
    expect(w3s.calls).toBe(1);
  });

  it('round-1 CRITICAL: both succeed with DIFFERENT CIDs (multicodec) → divergence flag set; warn logged', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = await pinFeedback(AAVE_SUPPLY, {
      primary: fakePin('pinata', VALID_CIDV1_A),
      fallback: fakePin('w3s-backup', VALID_CIDV1_B),
      logger,
    });
    expect(result.cidDivergence).toBe(true);
    expect(result.cid).toBe(VALID_CIDV1_A); // primary still wins
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = logger.warn.mock.calls.find((c) => String(c[1]).includes('divergence'));
    expect(warnCall).toBeTruthy();
  });

  it('primary fails + fallback ok → fallback CID wins; primary.ok=false', async () => {
    const out = await pinFeedback(AAVE_SUPPLY, {
      primary: failingPin('pinata', 'pinata: 503'),
      fallback: fakePin('w3s-backup', VALID_CIDV1_B),
    });
    expect(out.cid).toBe(VALID_CIDV1_B);
    expect(out.primary.ok).toBe(false);
    if (!out.primary.ok) {
      expect(out.primary.error).toContain('503');
      expect(out.primary.notConfigured).toBe(false);
    }
  });

  it('round-1 NEW: primary ok + fallback throws → primary CID wins; fallback marked error (not silently)', async () => {
    const out = await pinFeedback(AAVE_SUPPLY, {
      primary: fakePin('pinata', VALID_CIDV1_A),
      fallback: failingPin('w3s-backup', 'w3s: network ECONNRESET'),
    });
    expect(out.cid).toBe(VALID_CIDV1_A);
    expect(out.fallback.ok).toBe(false);
    if (!out.fallback.ok) {
      expect(out.fallback.error).toContain('ECONNRESET');
      expect(out.fallback.notConfigured).toBe(false);
    }
  });
});

describe('pinFeedback — degradation', () => {
  it('only primary configured + ok → fallback marked notConfigured (round-1 sentinel)', async () => {
    const out = await pinFeedback(AAVE_SUPPLY, { primary: fakePin('pinata', VALID_CIDV1_A) });
    expect(out.cid).toBe(VALID_CIDV1_A);
    expect(out.fallback.ok).toBe(false);
    if (!out.fallback.ok) {
      expect(out.fallback.notConfigured).toBe(true);
    }
  });

  it('only fallback configured + ok → primary marked notConfigured', async () => {
    const out = await pinFeedback(AAVE_SUPPLY, { fallback: fakePin('w3s-backup', VALID_CIDV1_B) });
    expect(out.cid).toBe(VALID_CIDV1_B);
    expect(out.primary.ok).toBe(false);
    if (!out.primary.ok) {
      expect(out.primary.notConfigured).toBe(true);
    }
  });

  it('NEITHER configured → ConfigError', async () => {
    await expect(pinFeedback(AAVE_SUPPLY, {})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });
});

describe('pinFeedback — both fail', () => {
  it('Pinata 500 + fallback 500 → ConciergeError(IPFSPinFailed) with structured metadata', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    await expect(
      pinFeedback(AAVE_SUPPLY, {
        primary: failingPin('pinata', 'pinata: 500 boom'),
        fallback: failingPin('w3s-backup', 'w3s: 500 boom'),
        logger,
      }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError) || e.type !== 'IPFSPinFailed') return false;
      const md = e.metadata as { hash?: string; agentId?: string } | undefined;
      return md?.hash === GOLDEN_AAVE_SUPPLY_HASH && md?.agentId === 'agent-1';
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('pinFeedback — AbortSignal threading (round-1 NEW)', () => {
  it('caller signal is passed to BOTH services', async () => {
    const pinata = fakePin('pinata', VALID_CIDV1_A);
    const w3s = fakePin('w3s-backup', VALID_CIDV1_C);
    const ctl = new AbortController();
    await pinFeedback(AAVE_SUPPLY, { primary: pinata, fallback: w3s, signal: ctl.signal });
    expect(pinata.lastSignal).toBe(ctl.signal);
    expect(w3s.lastSignal).toBe(ctl.signal);
  });

  it('no signal → defaults to AbortSignal.timeout (round-1 security CWE-400)', async () => {
    const pinata = fakePin('pinata', VALID_CIDV1_A);
    await pinFeedback(AAVE_SUPPLY, { primary: pinata });
    expect(pinata.lastSignal).toBeDefined();
    // The default is AbortSignal.timeout(15_000) — has aborted=false initially.
    expect(pinata.lastSignal?.aborted).toBe(false);
  });
});
