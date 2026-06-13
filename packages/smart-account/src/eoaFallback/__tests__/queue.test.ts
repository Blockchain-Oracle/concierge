import { randomUUID } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex, PublicClient } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proposeForUser } from '../proposer.ts';
import {
  enqueue,
  getPending,
  markConfirmed,
  markFailed,
  markSigned,
  type QueueRow,
} from '../queue.ts';
import { sendSignedTx } from '../sender.ts';

const USER_ID = 'user-1';
const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const TO = '0x1234567890123456789012345678901234567890' as Address;
const DATA = '0xdeadbeef' as Hex;
const VALUE = '1000000000000000000';
const SIGNED_TX = '0xabc123' as Hex;
const TX_HASH = '0x4444444444444444444444444444444444444444444444444444444444444444' as Hex;

function extractLiterals(where: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    // biome-ignore lint/suspicious/noExplicitAny: drizzle internals
    const n = node as any;
    if (typeof n.value === 'string' && !/is null/i.test(n.value)) out.push(n.value);
    if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) walk(c);
  }
  walk(where);
  return out;
}

function makeDb() {
  const rows: QueueRow[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: stub
  const db: any = {
    insert: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: drizzle
      values: (v: any) => ({
        returning: async (_proj?: unknown) => {
          const row: QueueRow = {
            id: randomUUID(),
            userId: v.userId,
            agentId: v.agentId,
            to: v.to,
            data: v.data,
            value: v.value,
            status: v.status,
            signedTx: null,
            txHash: null,
            blockNumber: null,
            error: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          rows.push(row);
          return [{ id: row.id, createdAt: row.createdAt }];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          const lits = extractLiterals(w);
          // getPending: agentId + status='pending'
          const matched = rows.filter((r) => lits.includes(r.agentId) && lits.includes(r.status));
          return {
            // biome-ignore lint/suspicious/noThenProperty: drizzle awaitable stub
            then: (resolve: (v: unknown) => unknown) => resolve(matched),
          };
        },
      }),
    }),
    update: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      set: (patch: any) => ({
        where: (w: unknown) => ({
          returning: async () => {
            const lits = extractLiterals(w);
            // Match by id literal; if the WHERE also carries a status literal,
            // enforce it (state-machine guards in markSigned/markConfirmed).
            const updated: QueueRow[] = [];
            for (const r of rows) {
              if (!lits.includes(r.id)) continue;
              const statusLit = lits.find((l) =>
                ['pending', 'signed', 'confirmed', 'failed'].includes(l),
              );
              if (statusLit && r.status !== statusLit) continue;
              Object.assign(r, patch, { updatedAt: new Date() });
              updated.push(r);
            }
            return updated;
          },
        }),
      }),
    }),
  };
  return { db, rows };
}

describe('eoaFallback queue (story-55)', () => {
  describe('enqueue', () => {
    it('inserts a pending row and returns id + createdAt', async () => {
      const { db, rows } = makeDb();
      const result = await enqueue(db, {
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      });
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(rows[0]).toMatchObject({ status: 'pending', agentId: AGENT_A, to: TO });
    });

    it('rejects invalid agentId / address / hex / value at the boundary', async () => {
      const { db } = makeDb();
      const base = { userId: USER_ID, agentId: AGENT_A, to: TO, data: DATA, value: VALUE };
      await expect(enqueue(db, { ...base, agentId: 'not-a-uuid' })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
      await expect(enqueue(db, { ...base, to: '0xnotanaddress' as Address })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
      await expect(enqueue(db, { ...base, data: '0xabc' as Hex })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
      await expect(enqueue(db, { ...base, value: '-1' })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
      await expect(enqueue(db, { ...base, value: '1'.repeat(79) })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
    });

    it('concurrent enqueue: 100 parallel inserts all land with unique ids', async () => {
      const { db, rows } = makeDb();
      const inputs = Array.from({ length: 100 }, () => ({
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      }));
      const results = await Promise.all(inputs.map((i) => enqueue(db, i)));
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(100);
      expect(rows.length).toBe(100);
    });
  });

  describe('getPending', () => {
    it('returns ONLY agent-A pending rows; agent-B rows do not leak', async () => {
      const { db } = makeDb();
      await enqueue(db, { userId: USER_ID, agentId: AGENT_A, to: TO, data: DATA, value: VALUE });
      await enqueue(db, { userId: USER_ID, agentId: AGENT_B, to: TO, data: DATA, value: VALUE });
      await enqueue(db, { userId: USER_ID, agentId: AGENT_A, to: TO, data: DATA, value: VALUE });
      const pendingA = await getPending(db, { agentId: AGENT_A });
      expect(pendingA).toHaveLength(2);
      for (const r of pendingA) expect(r.agentId).toBe(AGENT_A);
    });

    it('throws ConfigError on invalid agentId', async () => {
      const { db } = makeDb();
      await expect(getPending(db, { agentId: 'bogus' })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
    });
  });

  describe('state machine (markSigned / markConfirmed / markFailed)', () => {
    it('happy lifecycle: pending → signed → confirmed', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, {
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      });
      const signed = await markSigned(db, { id, signedTx: SIGNED_TX, txHash: TX_HASH });
      expect(signed?.status).toBe('signed');
      expect(signed?.txHash).toBe(TX_HASH);
      const confirmed = await markConfirmed(db, { id, blockNumber: 12345n });
      expect(confirmed?.status).toBe('confirmed');
      expect(confirmed?.blockNumber).toBe(12345n);
    });

    it('markSigned guard: returns null if row is not pending (double-fire safety)', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, {
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      });
      await markSigned(db, { id, signedTx: SIGNED_TX, txHash: TX_HASH });
      const second = await markSigned(db, { id, signedTx: SIGNED_TX, txHash: TX_HASH });
      expect(second).toBeNull();
    });

    it('markConfirmed guard: returns null if row is not signed', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, {
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      });
      const result = await markConfirmed(db, { id, blockNumber: 1n });
      expect(result).toBeNull();
    });

    it('markFailed: works from pending OR signed; rejects empty error message', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, {
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      });
      await expect(markFailed(db, { id, error: '' })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
      const failed = await markFailed(db, { id, error: 'gas estimation failed' });
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toBe('gas estimation failed');
    });
  });

  describe('proposeForUser', () => {
    it('enqueues and emits eoa.proposal.pending', async () => {
      const { db } = makeDb();
      const events = { emit: vi.fn().mockResolvedValue(undefined) };
      const result = await proposeForUser({
        db,
        txParams: { userId: USER_ID, agentId: AGENT_A, to: TO, data: DATA, value: VALUE },
        events,
      });
      expect(result.queueId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events.emit).toHaveBeenCalledWith(
        'eoa.proposal.pending',
        expect.objectContaining({ queueId: result.queueId, agentId: AGENT_A, to: TO }),
      );
    });

    it('emit failure is non-fatal — row still enqueued, error logged', async () => {
      const { db, rows } = makeDb();
      const events = { emit: vi.fn().mockRejectedValue(new Error('redis down')) };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await proposeForUser({
        db,
        txParams: { userId: USER_ID, agentId: AGENT_A, to: TO, data: DATA, value: VALUE },
        events,
      });
      expect(result.queueId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]?.status).toBe('pending');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('emit failed'),
        expect.objectContaining({ queueId: result.queueId }),
      );
      errSpy.mockRestore();
    });
  });

  describe('sendSignedTx', () => {
    function makePublicClientStub(opts: {
      sendThrows?: Error;
      receiptStatus?: 'success' | 'reverted';
      receiptThrows?: Error;
    }): PublicClient {
      // biome-ignore lint/suspicious/noExplicitAny: viem PublicClient stub
      const stub: any = {
        sendRawTransaction: vi.fn(async () => {
          if (opts.sendThrows) throw opts.sendThrows;
          return TX_HASH;
        }),
        waitForTransactionReceipt: vi.fn(async () => {
          if (opts.receiptThrows) throw opts.receiptThrows;
          return {
            status: opts.receiptStatus ?? 'success',
            blockNumber: 9999n,
            transactionHash: TX_HASH,
          };
        }),
      };
      return stub as PublicClient;
    }

    let db: ReturnType<typeof makeDb>['db'];
    let queueId: string;
    beforeEach(async () => {
      const h = makeDb();
      db = h.db;
      const { id } = await enqueue(db, {
        userId: USER_ID,
        agentId: AGENT_A,
        to: TO,
        data: DATA,
        value: VALUE,
      });
      queueId = id;
    });

    it('happy path: broadcast → markSigned → receipt success → markConfirmed', async () => {
      const result = await sendSignedTx({
        db,
        publicClient: makePublicClientStub({ receiptStatus: 'success' }),
        queueId,
        signedTx: SIGNED_TX,
      });
      expect(result.kind).toBe('confirmed');
      if (result.kind === 'confirmed') {
        expect(result.row.status).toBe('confirmed');
        expect(result.row.blockNumber).toBe(9999n);
      }
    });

    it('on-chain revert → markFailed with revert reason', async () => {
      const result = await sendSignedTx({
        db,
        publicClient: makePublicClientStub({ receiptStatus: 'reverted' }),
        queueId,
        signedTx: SIGNED_TX,
      });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.row.status).toBe('failed');
        expect(result.error).toMatch(/reverted/);
      }
    });

    it('pre-broadcast viem error → markFailed; row never reaches signed', async () => {
      const result = await sendSignedTx({
        db,
        publicClient: makePublicClientStub({ sendThrows: new Error('insufficient funds') }),
        queueId,
        signedTx: SIGNED_TX,
      });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.row.status).toBe('failed');
        expect(result.row.signedTx).toBeNull();
        expect(result.error).toMatch(/insufficient funds/);
      }
    });

    it('receipt timeout → markFailed', async () => {
      const result = await sendSignedTx({
        db,
        publicClient: makePublicClientStub({
          receiptThrows: new Error('Timed out while waiting for transaction'),
        }),
        queueId,
        signedTx: SIGNED_TX,
      });
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.error).toMatch(/Timed out/);
      }
    });

    it('rejects invalid signedTx hex at boundary', async () => {
      await expect(
        sendSignedTx({
          db,
          publicClient: makePublicClientStub({}),
          queueId,
          signedTx: 'not-hex' as Hex,
        }),
      ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    });
  });
});
