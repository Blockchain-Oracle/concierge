import { describe, expect, it, vi } from 'vitest';
import { getOrFetchPayload, type IpfsCacheRepo, type IpfsGatewayFetcher } from '../ipfsCache.ts';
import type { FeedbackEnvelope } from '../schema.ts';

const CID_ALPHA = 'abcdefgh';
const VALID_CID = (i: number) =>
  `bafybeibq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqx${CID_ALPHA[Math.floor(i / 8) % 8]}${CID_ALPHA[i % 8]}`;

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

describe('round-2: stale cache eviction', () => {
  it('cache hit with INVALID JSON → logs, evicts, re-fetches via gateway', async () => {
    const cid = VALID_CID(1);
    let getCount = 0;
    let deleted = false;
    const repo: IpfsCacheRepo = {
      async get() {
        getCount++;
        return { content: 'malformed not json' };
      },
      async put() {},
      async touch() {
        throw new Error('touch must NOT be called on poisoned entry');
      },
      async delete() {
        deleted = true;
      },
    };
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        return { ok: true, status: 200, text: JSON.stringify(envelope(1)) };
      },
    };
    const logger = { error: vi.fn() };
    const res = await getOrFetchPayload(cid, { repo, gateway, logger });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe('gateway');
    expect(deleted).toBe(true);
    expect(getCount).toBe(1);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls[0]?.[1]).toMatch(/stale|evicting/i);
  });

  it('delete failure during eviction still surfaces gateway result + logs both errors', async () => {
    const repo: IpfsCacheRepo = {
      async get() {
        return { content: 'malformed' };
      },
      async put() {},
      async touch() {},
      async delete() {
        throw new Error('delete failed');
      },
    };
    const gateway: IpfsGatewayFetcher = {
      async fetch() {
        return { ok: true, status: 200, text: JSON.stringify(envelope(1)) };
      },
    };
    const logger = { error: vi.fn() };
    const res = await getOrFetchPayload(VALID_CID(1), { repo, gateway, logger });
    expect(res.ok).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
