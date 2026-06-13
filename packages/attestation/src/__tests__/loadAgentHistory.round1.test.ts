import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  createGatewayFetcher,
  type GetOrFetchDeps,
  getOrFetchPayload,
  type IpfsCacheRepo,
  type IpfsGatewayFetcher,
  MAX_CONTENT_BYTES,
} from '../ipfsCache.ts';
import {
  type LoadAgentHistoryDeps,
  loadAgentHistory,
  type RawFeedbackEntry,
} from '../loadAgentHistory.ts';
import type { FeedbackEnvelope } from '../schema.ts';

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

describe('round-1: createGatewayFetcher URL validation (CWE-918 SSRF)', () => {
  it('non-URL primary → ConfigError', () => {
    expect(() => createGatewayFetcher({ primary: 'not a url' })).toThrow(
      /must be a valid absolute URL/,
    );
  });

  it('non-http(s) scheme → ConfigError', () => {
    expect(() => createGatewayFetcher({ primary: 'ftp://example.com' })).toThrow(/http\(s\)/);
  });

  it('non-origin-only base (has path) → ConfigError', () => {
    expect(() => createGatewayFetcher({ primary: 'https://ipfs.io/path/here' })).toThrow(
      /origin-only/,
    );
  });

  it('non-origin-only base (has query) → ConfigError', () => {
    expect(() => createGatewayFetcher({ primary: 'https://ipfs.io/?leak=' })).toThrow(
      /origin-only/,
    );
  });

  it('fallback validated symmetrically', () => {
    expect(() =>
      createGatewayFetcher({ primary: 'https://ipfs.io', fallback: 'javascript:alert(1)' }),
    ).toThrow(/http\(s\)/);
  });

  it('happy path: validated URLs construct fetcher; primary serves successfully', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(envelope(1)), {
        status: 200,
        headers: { 'content-length': String(JSON.stringify(envelope(1)).length) },
      });
    };
    const g = createGatewayFetcher({
      primary: 'https://ipfs.io',
      fallback: 'https://cloudflare-ipfs.com',
      fetchImpl,
    });
    const r = await g.fetch(VALID_CID(1), AbortSignal.timeout(5000));
    expect(r.status).toBe(200);
    expect(calls[0]).toMatch(/^https:\/\/ipfs\.io\/ipfs\//);
  });
});

describe('round-1: streaming size cap (CWE-770)', () => {
  it('content-length header > MAX → typed oversized result (NOT 1MB string alloc)', async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(MAX_CONTENT_BYTES + 100) },
      });
    const g = createGatewayFetcher({ primary: 'https://ipfs.io', fetchImpl });
    const r = await g.fetch(VALID_CID(1), AbortSignal.timeout(5000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversized');
  });

  it('round-2: content-length NaN → falls through to streaming counter (does NOT bypass)', async () => {
    let totalEmitted = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new Uint8Array(200_000);
          totalEmitted += chunk.byteLength;
          if (totalEmitted > MAX_CONTENT_BYTES * 2) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-length': 'abc' } });
    };
    const g = createGatewayFetcher({ primary: 'https://ipfs.io', fetchImpl });
    const r = await g.fetch(VALID_CID(1), AbortSignal.timeout(5000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversized');
  });

  it('streamed body > MAX → reader cancelled; returns typed oversized result', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      let emitted = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted > MAX_CONTENT_BYTES * 2) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(100_000));
          emitted += 100_000;
        },
      });
      return new Response(stream, { status: 200, headers: {} });
    };
    const g = createGatewayFetcher({ primary: 'https://ipfs.io', fetchImpl });
    const r = await g.fetch(VALID_CID(1), AbortSignal.timeout(5000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('oversized');
  });

  it('getOrFetchPayload surfaces oversized as SCHEMA_VIOLATION', async () => {
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        return { ok: false, reason: 'oversized', status: 200 };
      },
    };
    const res = await getOrFetchPayload(VALID_CID(1), { repo: inMemRepo(), gateway });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('SCHEMA_VIOLATION');
      expect(res.cause).toContain('exceeds');
    }
  });
});

describe('round-1: TIMEOUT payloadError path', () => {
  it('AbortError from gateway → payloadError TIMEOUT', async () => {
    const e = rawEntry(1);
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const out = await loadAgentHistory({ agentId: 1n }, {
      readFeedback: async () => ({ entries: [e] }),
      ipfs: { repo: inMemRepo(), gateway },
    } as LoadAgentHistoryDeps);
    expect(out.entries[0]).toMatchObject({ status: 'error', payloadError: 'TIMEOUT' });
  });

  it('TimeoutError from gateway → payloadError TIMEOUT', async () => {
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        const err = new Error('timed out');
        err.name = 'TimeoutError';
        throw err;
      },
    };
    const res = await getOrFetchPayload(VALID_CID(1), { repo: inMemRepo(), gateway });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('TIMEOUT');
  });
});

describe('round-1: cache write failure observability (silent-failure fix)', () => {
  it('repo.put rejects → log emitted; read still ok', async () => {
    const repo: IpfsCacheRepo = {
      async get() {
        return null;
      },
      async put() {
        throw new Error('pg pool drained');
      },
      async touch() {},
      async delete() {},
    };
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        return { ok: true, status: 200, text: JSON.stringify(envelope(1)) };
      },
    };
    const logger = { error: vi.fn() };
    const deps: GetOrFetchDeps = { repo, gateway, logger };
    const res = await getOrFetchPayload(VALID_CID(1), deps);
    expect(res.ok).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const meta = logger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(meta?.['cid']).toBe(VALID_CID(1));
    expect(meta?.['errName']).toBe('Error');
  });

  it('round-2: repo.put ConciergeError is ALSO swallowed + logged (contract: read MUST succeed)', async () => {
    const repo: IpfsCacheRepo = {
      async get() {
        return null;
      },
      async put() {
        throw new ConciergeError('ConfigError', 'cache misconfigured');
      },
      async touch() {},
      async delete() {},
    };
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        return { ok: true, status: 200, text: JSON.stringify(envelope(1)) };
      },
    };
    const logger = { error: vi.fn() };
    const res = await getOrFetchPayload(VALID_CID(1), { repo, gateway, logger });
    expect(res.ok).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('round-1: AgentHistoryEntry discriminated union', () => {
  it('error variant carries payloadError + does NOT have payload field', async () => {
    const e = rawEntry(1, { feedbackURI: 'https://evil.example/x' });
    const out = await loadAgentHistory({ agentId: 1n }, {
      readFeedback: async () => ({ entries: [e] }),
      ipfs: {
        repo: inMemRepo(),
        gateway: {
          async fetch() {
            return { ok: false, reason: 'http', status: 404 };
          },
        },
      },
    } as LoadAgentHistoryDeps);
    const got = out.entries[0];
    expect(got?.status).toBe('error');
    // Sanity: in the error variant, 'payload' is not a typed field.
    expect((got as { payload?: unknown }).payload).toBeUndefined();
  });

  it('ok variant carries payload + does NOT have payloadError field', async () => {
    const e = rawEntry(1);
    const cid = e.feedbackURI.slice('ipfs://'.length);
    const repo = inMemRepo({ [cid]: JSON.stringify(envelope(1)) });
    const out = await loadAgentHistory({ agentId: 1n }, {
      readFeedback: async () => ({ entries: [e] }),
      ipfs: {
        repo,
        gateway: {
          async fetch() {
            return { ok: false, reason: 'http', status: 404 };
          },
        },
      },
    } as LoadAgentHistoryDeps);
    const got = out.entries[0];
    expect(got?.status).toBe('ok');
    expect((got as { payloadError?: unknown }).payloadError).toBeUndefined();
  });
});

describe('round-1: stronger cache assertions (test-quality)', () => {
  it('cache-hit asserts get was called AND put was NOT (proves read came from cache)', async () => {
    const e = rawEntry(1);
    const cid = e.feedbackURI.slice('ipfs://'.length);
    const repo = inMemRepo({ [cid]: JSON.stringify(envelope(1)) });
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        throw new Error('should not be called');
      },
    };
    const res = await getOrFetchPayload(cid, { repo, gateway });
    expect(res.ok).toBe(true);
    expect(repo.getCalls).toEqual([cid]);
    expect(repo.putCalls).toHaveLength(0);
    expect(repo.touchCalls).toEqual([cid]);
  });

  it('non-ipfs URI short-circuits BEFORE repo.get (no wasted DB hit)', async () => {
    const e = rawEntry(1, { feedbackURI: 'https://evil.example/x' });
    const repo = inMemRepo();
    await loadAgentHistory({ agentId: 1n }, {
      readFeedback: async () => ({ entries: [e] }),
      ipfs: {
        repo,
        gateway: {
          async fetch() {
            return { ok: false, reason: 'http', status: 404 };
          },
        },
      },
    } as LoadAgentHistoryDeps);
    expect(repo.getCalls).toHaveLength(0);
  });
});
