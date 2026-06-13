import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { GetOrFetchDeps, IpfsCacheRepo, IpfsGatewayFetcher } from '../ipfsCache.ts';
import {
  type LoadAgentHistoryDeps,
  loadAgentHistory,
  type RawFeedbackEntry,
} from '../loadAgentHistory.ts';
import type { FeedbackEnvelope } from '../schema.ts';

// Base32 alphabet is [a-z2-7] only — digits 0/1 are NOT valid, so index via
// a small valid charset for the suffix.
const CID_ALPHA = 'abcdefgh';
const VALID_CID = (i: number) =>
  `bafybeibq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqx${CID_ALPHA[Math.floor(i / 8) % 8]}${CID_ALPHA[i % 8]}`;
const TX = (i: number): `0x${string}` => `0x${String(i).padStart(64, 'a')}`;
const HASH = (i: number): `0x${string}` => `0x${String(i).padStart(64, 'b')}`;

function envelope(i: number): FeedbackEnvelope {
  return {
    v: 1,
    schema: 'concierge.aave.v3.supply.v1',
    agentId: '1',
    chainId: 5000,
    payload: { asset: '0xUSDC', amount: String(i * 1000) },
    createdAt: '2026-06-13T12:00:00Z',
  };
}

function rawEntry(i: number, override?: Partial<RawFeedbackEntry>): RawFeedbackEntry {
  return {
    schema: 'concierge.aave.v3.supply.v1',
    feedbackHash: HASH(i),
    feedbackURI: `ipfs://${VALID_CID(i)}`,
    feedbackIndex: BigInt(i),
    clientAddress: `0x${'c'.repeat(40)}`,
    blockNumber: BigInt(1000 + i),
    txHash: TX(i),
    revoked: false,
    ...override,
  };
}

function inMemRepo(seed: Record<string, string> = {}): IpfsCacheRepo & {
  getCalls: string[];
  putCalls: Array<{ cid: string; content: string }>;
  touchCalls: string[];
} {
  const store = new Map(Object.entries(seed));
  const getCalls: string[] = [];
  const putCalls: Array<{ cid: string; content: string }> = [];
  const touchCalls: string[] = [];
  return {
    getCalls,
    putCalls,
    touchCalls,
    async get(cid) {
      getCalls.push(cid);
      const content = store.get(cid);
      return content === undefined ? null : { content };
    },
    async put(row) {
      putCalls.push({ ...row });
      store.set(row.cid, row.content);
    },
    async touch(cid) {
      touchCalls.push(cid);
    },
    async delete(cid: string) {
      store.delete(cid);
    },
  };
}

function fakeGateway(
  responses: Record<string, { status: number; text: string }>,
): IpfsGatewayFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(cid) {
      calls.push(cid);
      const r = responses[cid];
      if (r === undefined) return { ok: false, reason: 'http', status: 404 };
      if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, text: r.text };
      return { ok: false, reason: 'http', status: r.status };
    },
  };
}

function fakeReadFeedback(entries: RawFeedbackEntry[]) {
  return vi.fn(async () => ({ entries }));
}

function deps(
  readFeedback: LoadAgentHistoryDeps['readFeedback'],
  ipfs: GetOrFetchDeps,
): LoadAgentHistoryDeps {
  return { readFeedback, ipfs };
}

describe('loadAgentHistory — happy path', () => {
  it('returns 5 entries enriched with decoded payloads', async () => {
    const entries = [1, 2, 3, 4, 5].map((i) => rawEntry(i));
    const gateway = fakeGateway(
      Object.fromEntries(
        entries.map((e) => [
          e.feedbackURI.slice('ipfs://'.length),
          { status: 200, text: JSON.stringify(envelope(Number(e.feedbackIndex))) },
        ]),
      ),
    );
    const repo = inMemRepo();
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback(entries), { repo, gateway }),
    );
    expect(out.entries).toHaveLength(5);
    expect(out.totalCount).toBe(5);
    for (const e of out.entries) {
      expect(e.status).toBe('ok');
      if (e.status === 'ok') {
        expect(e.payload.schema).toBe('concierge.aave.v3.supply.v1');
      }
    }
  });
});

describe('loadAgentHistory — partial results', () => {
  it('404 on gateway → payloadError NOT_FOUND, other entries returned normally', async () => {
    const ok = rawEntry(1);
    const bad = rawEntry(2);
    const gateway = fakeGateway({
      [ok.feedbackURI.slice('ipfs://'.length)]: { status: 200, text: JSON.stringify(envelope(1)) },
      // bad.feedbackURI missing → defaults to 404
    });
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback([ok, bad]), { repo: inMemRepo(), gateway }),
    );
    expect(out.entries[0]?.status).toBe('ok');
    expect(out.entries[1]).toMatchObject({ status: 'error', payloadError: 'NOT_FOUND' });
  });

  it('malformed JSON on gateway → SCHEMA_VIOLATION (not throw)', async () => {
    const e = rawEntry(1);
    const gateway = fakeGateway({
      [e.feedbackURI.slice('ipfs://'.length)]: { status: 200, text: 'not json' },
    });
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback([e]), { repo: inMemRepo(), gateway }),
    );
    expect(out.entries[0]).toMatchObject({ status: 'error', payloadError: 'SCHEMA_VIOLATION' });
  });

  it('envelope JSON parses but fails schema → SCHEMA_VIOLATION', async () => {
    const e = rawEntry(1);
    const gateway = fakeGateway({
      [e.feedbackURI.slice('ipfs://'.length)]: {
        status: 200,
        text: JSON.stringify({ v: 999, totallyWrong: true }),
      },
    });
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback([e]), { repo: inMemRepo(), gateway }),
    );
    expect(out.entries[0]).toMatchObject({ status: 'error', payloadError: 'SCHEMA_VIOLATION' });
  });

  it('non-ipfs:// URI → NOT_FOUND (typed, not throw)', async () => {
    const e = rawEntry(1, { feedbackURI: 'https://evil.example/x' });
    const gateway = fakeGateway({});
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback([e]), { repo: inMemRepo(), gateway }),
    );
    expect(out.entries[0]).toMatchObject({ status: 'error', payloadError: 'NOT_FOUND' });
    expect(gateway.calls).toHaveLength(0);
  });
});

describe('loadAgentHistory — cache behavior', () => {
  it('cache hit → NO gateway calls; lastAccessedAt touched', async () => {
    const e = rawEntry(1);
    const cid = e.feedbackURI.slice('ipfs://'.length);
    const repo = inMemRepo({ [cid]: JSON.stringify(envelope(1)) });
    const gateway = fakeGateway({});
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback([e]), { repo, gateway }),
    );
    expect(out.entries[0]?.status).toBe('ok');
    expect(gateway.calls).toHaveLength(0);
    expect(repo.touchCalls).toEqual([cid]);
  });

  it('cache miss → gateway fetched + result cached for next call', async () => {
    const e = rawEntry(1);
    const cid = e.feedbackURI.slice('ipfs://'.length);
    const repo = inMemRepo();
    const gateway = fakeGateway({ [cid]: { status: 200, text: JSON.stringify(envelope(1)) } });
    const d = deps(fakeReadFeedback([e]), { repo, gateway });
    await loadAgentHistory({ agentId: 1n }, d);
    expect(repo.putCalls).toEqual([{ cid, content: JSON.stringify(envelope(1)) }]);

    // Second call should hit the cache — clear gateway then re-run.
    gateway.calls.length = 0;
    await loadAgentHistory({ agentId: 1n }, d);
    expect(gateway.calls).toHaveLength(0);
  });
});

describe('loadAgentHistory — pagination', () => {
  it('limit + offset slices the list; totalCount reflects raw length', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => rawEntry(i + 1));
    const gateway = fakeGateway(
      Object.fromEntries(
        entries.map((e) => [
          e.feedbackURI.slice('ipfs://'.length),
          { status: 200, text: JSON.stringify(envelope(Number(e.feedbackIndex))) },
        ]),
      ),
    );
    const d = deps(fakeReadFeedback(entries), { repo: inMemRepo(), gateway });
    const page1 = await loadAgentHistory({ agentId: 1n, limit: 10, offset: 0 }, d);
    const page2 = await loadAgentHistory({ agentId: 1n, limit: 10, offset: 10 }, d);
    expect(page1.entries).toHaveLength(10);
    expect(page2.entries).toHaveLength(10);
    expect(page1.totalCount).toBe(25);
    expect(page2.totalCount).toBe(25);
    expect(page1.entries[0]?.feedbackIndex).toBe(1n);
    expect(page2.entries[0]?.feedbackIndex).toBe(11n);
    // No overlap.
    const page1Idx = new Set(page1.entries.map((e) => e.feedbackIndex));
    expect(page2.entries.some((e) => page1Idx.has(e.feedbackIndex))).toBe(false);
  });

  it('default limit is 50 when not specified', async () => {
    const entries = Array.from({ length: 80 }, (_, i) => rawEntry(i + 1));
    const gateway = fakeGateway(
      Object.fromEntries(
        entries.map((e) => [
          e.feedbackURI.slice('ipfs://'.length),
          { status: 200, text: JSON.stringify(envelope(Number(e.feedbackIndex))) },
        ]),
      ),
    );
    const out = await loadAgentHistory(
      { agentId: 1n },
      deps(fakeReadFeedback(entries), { repo: inMemRepo(), gateway }),
    );
    expect(out.limit).toBe(50);
    expect(out.entries).toHaveLength(50);
    expect(out.totalCount).toBe(80);
  });
});

describe('loadAgentHistory — boundary fail-fast', () => {
  it('limit > MAX_LIMIT → ConfigError BEFORE readFeedback', async () => {
    const readFeedback = vi.fn();
    await expect(
      loadAgentHistory(
        { agentId: 1n, limit: 9999 },
        deps(readFeedback as never, { repo: inMemRepo(), gateway: fakeGateway({}) }),
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    expect(readFeedback).not.toHaveBeenCalled();
  });

  it('offset < 0 → ConfigError', async () => {
    await expect(
      loadAgentHistory(
        { agentId: 1n, offset: -1 },
        deps(vi.fn() as never, { repo: inMemRepo(), gateway: fakeGateway({}) }),
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('negative agentId → ConfigError', async () => {
    await expect(
      loadAgentHistory(
        { agentId: -1n },
        deps(vi.fn() as never, { repo: inMemRepo(), gateway: fakeGateway({}) }),
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });
});
