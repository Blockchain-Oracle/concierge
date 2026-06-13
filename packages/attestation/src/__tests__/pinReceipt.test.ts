import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PinFeedbackResult } from '../pin.ts';
import { type PinReceiptRepository, recordPinReceipt } from '../pinReceipt.ts';
import { GOLDEN_AAVE_SUPPLY_HASH } from './__fixtures__/envelopes.ts';

afterEach(() => vi.restoreAllMocks());

const CID = 'bafybeibq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';
const CID_B = 'bafybeicq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';

const SUCCESS_RESULT: PinFeedbackResult = {
  cid: CID,
  canonical: '{"v":1}',
  hash: GOLDEN_AAVE_SUPPLY_HASH,
  cidDivergence: false,
  primary: { service: 'pinata', ok: true, cid: CID, pinId: `pinata:${CID}` },
  fallback: { service: 'w3s', ok: true, cid: CID, pinId: `w3s:${CID}` },
};

const DIVERGENT_RESULT: PinFeedbackResult = {
  cid: CID,
  canonical: '{"v":1}',
  hash: GOLDEN_AAVE_SUPPLY_HASH,
  cidDivergence: true,
  primary: { service: 'pinata', ok: true, cid: CID, pinId: `pinata:${CID}` },
  fallback: { service: 'w3s', ok: true, cid: CID_B, pinId: `w3s:${CID_B}` },
};

const PARTIAL_RESULT: PinFeedbackResult = {
  cid: CID_B,
  canonical: '{"v":1}',
  hash: GOLDEN_AAVE_SUPPLY_HASH,
  cidDivergence: false,
  primary: { service: 'pinata', ok: false, error: 'pinata: 503', notConfigured: false },
  fallback: { service: 'w3s', ok: true, cid: CID_B, pinId: `w3s:${CID_B}` },
};

const FALLBACK_NOT_CONFIGURED: PinFeedbackResult = {
  cid: CID,
  canonical: '{"v":1}',
  hash: GOLDEN_AAVE_SUPPLY_HASH,
  cidDivergence: false,
  primary: { service: 'pinata', ok: true, cid: CID, pinId: `pinata:${CID}` },
  fallback: {
    service: '<unconfigured>',
    ok: false,
    error: "pin service '<unconfigured>' not configured",
    notConfigured: true,
  },
};

describe('recordPinReceipt', () => {
  it('happy path: both ok → row carries both CIDs + pinIds; cidDivergence=false', async () => {
    const inserted: unknown[] = [];
    const repo: PinReceiptRepository = {
      insert: vi.fn().mockImplementation(async (row) => {
        inserted.push(row);
        return { id: 'receipt-1' };
      }),
    };
    await recordPinReceipt({ agentId: '1', result: SUCCESS_RESULT }, { repository: repo });
    const row = inserted[0] as Record<string, unknown>;
    expect(row['cid']).toBe(CID);
    expect(row['primaryCid']).toBe(CID);
    expect(row['fallbackCid']).toBe(CID);
    expect(row['cidDivergence']).toBe(false);
    expect(row['primaryOk']).toBe(true);
    expect(row['fallbackOk']).toBe(true);
  });

  it('round-1: divergent CIDs → BOTH persisted; cidDivergence=true', async () => {
    const inserted: unknown[] = [];
    const repo: PinReceiptRepository = {
      insert: vi.fn().mockImplementation(async (row) => {
        inserted.push(row);
        return { id: 'r-2' };
      }),
    };
    await recordPinReceipt({ agentId: '1', result: DIVERGENT_RESULT }, { repository: repo });
    const row = inserted[0] as Record<string, unknown>;
    expect(row['primaryCid']).toBe(CID);
    expect(row['fallbackCid']).toBe(CID_B);
    expect(row['cidDivergence']).toBe(true);
  });

  it('partial: primary failed → primaryError populated; primaryCid null', async () => {
    const inserted: unknown[] = [];
    const repo: PinReceiptRepository = {
      insert: vi.fn().mockImplementation(async (row) => {
        inserted.push(row);
        return { id: 'r-3' };
      }),
    };
    await recordPinReceipt({ agentId: '1', result: PARTIAL_RESULT }, { repository: repo });
    const row = inserted[0] as Record<string, unknown>;
    expect(row['primaryOk']).toBe(false);
    expect(row['primaryError']).toContain('503');
    expect(row['primaryCid']).toBeNull();
    expect(row['primaryNotConfigured']).toBe(false);
    expect(row['fallbackOk']).toBe(true);
  });

  it('round-1: notConfigured fallback → row carries fallbackNotConfigured=true; ops can split unconfigured from failed', async () => {
    const inserted: unknown[] = [];
    const repo: PinReceiptRepository = {
      insert: vi.fn().mockImplementation(async (row) => {
        inserted.push(row);
        return { id: 'r-4' };
      }),
    };
    await recordPinReceipt({ agentId: '1', result: FALLBACK_NOT_CONFIGURED }, { repository: repo });
    const row = inserted[0] as Record<string, unknown>;
    expect(row['fallbackOk']).toBe(false);
    expect(row['fallbackNotConfigured']).toBe(true);
  });

  it('insert throws → RpcError with cid + agentId + hash in metadata', async () => {
    const repo: PinReceiptRepository = {
      insert: vi.fn().mockRejectedValue(new Error('drizzle blew up')),
    };
    await expect(
      recordPinReceipt({ agentId: '1', result: SUCCESS_RESULT }, { repository: repo }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const md = e.metadata as { cid?: string; agentId?: string; hash?: string } | undefined;
      return (
        e.type === 'RpcError' &&
        md?.cid === CID &&
        md?.agentId === '1' &&
        md?.hash === GOLDEN_AAVE_SUPPLY_HASH
      );
    });
  });
});
