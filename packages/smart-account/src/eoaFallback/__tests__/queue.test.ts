import { randomUUID } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { proposeForUser } from '../proposer.ts';
import { enqueue, getPending, markConfirmed, markFailed, markSigned } from '../queue.ts';
import { AGENT_A, AGENT_B, BASE_ENQ, makeDb, OTHER_USER, TX_HASH, USER_ID } from './_eoaStub.ts';

describe('eoaFallback queue (story-55)', () => {
  describe('enqueue', () => {
    it('inserts a pending row and returns id + createdAt', async () => {
      const { db, rows } = makeDb();
      const result = await enqueue(db, BASE_ENQ);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]).toMatchObject({ status: 'pending', agentId: AGENT_A });
    });

    it('rejects invalid inputs at the boundary', async () => {
      const { db } = makeDb();
      const bad = [
        { ...BASE_ENQ, userId: '' },
        { ...BASE_ENQ, agentId: 'not-a-uuid' },
        { ...BASE_ENQ, to: '0xnotanaddress' as Address },
        { ...BASE_ENQ, data: '0xabc' as Hex },
        { ...BASE_ENQ, value: '-1' },
        { ...BASE_ENQ, value: '1'.repeat(79) },
      ];
      for (const b of bad) {
        await expect(enqueue(db, b)).rejects.toSatisfy(
          (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
        );
      }
    });

    it('concurrent enqueue: parallel inserts are non-throwing and produce one row each', async () => {
      const { db, rows } = makeDb();
      const results = await Promise.all(Array.from({ length: 100 }, () => enqueue(db, BASE_ENQ)));
      expect(results).toHaveLength(100);
      expect(rows).toHaveLength(100);
    });
  });

  describe('getPending', () => {
    it('returns ONLY (agent-A, user-1) pending rows', async () => {
      const { db } = makeDb();
      await enqueue(db, BASE_ENQ);
      await enqueue(db, { ...BASE_ENQ, agentId: AGENT_B });
      await enqueue(db, { ...BASE_ENQ, userId: OTHER_USER });
      await enqueue(db, BASE_ENQ);
      const pending = await getPending(db, { agentId: AGENT_A, expectedUserId: USER_ID });
      expect(pending).toHaveLength(2);
      for (const r of pending) {
        expect(r.agentId).toBe(AGENT_A);
        expect(r.userId).toBe(USER_ID);
      }
    });

    it('returns [] when only non-pending rows exist for the agent', async () => {
      const { db, rows } = makeDb();
      await enqueue(db, BASE_ENQ);
      if (rows[0]) rows[0].status = 'confirmed';
      const pending = await getPending(db, { agentId: AGENT_A, expectedUserId: USER_ID });
      expect(pending).toHaveLength(0);
    });

    it('rejects invalid agentId / userId', async () => {
      const { db } = makeDb();
      await expect(getPending(db, { agentId: 'bogus', expectedUserId: USER_ID })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
      await expect(getPending(db, { agentId: AGENT_A, expectedUserId: '' })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
    });
  });

  describe('state machine (discriminated MarkResult)', () => {
    it('happy lifecycle: pending → signed → confirmed', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, BASE_ENQ);
      const signed = await markSigned(db, {
        id,
        expectedUserId: USER_ID,
        signedTx: '0xabcd' as Hex,
        txHash: TX_HASH,
      });
      expect(signed.kind).toBe('updated');
      const confirmed = await markConfirmed(db, {
        id,
        expectedUserId: USER_ID,
        blockNumber: 12345n,
      });
      expect(confirmed.kind).toBe('updated');
      if (confirmed.kind === 'updated') expect(confirmed.row.blockNumber).toBe(12345n);
    });

    it('markSigned wrong-tenant returns not-authorized (IDOR defense)', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, BASE_ENQ);
      const result = await markSigned(db, {
        id,
        expectedUserId: OTHER_USER,
        signedTx: '0xabcd' as Hex,
        txHash: TX_HASH,
      });
      expect(result.kind).toBe('not-authorized');
    });

    it('markSigned not-found returns not-found', async () => {
      const { db } = makeDb();
      const result = await markSigned(db, {
        id: randomUUID(),
        expectedUserId: USER_ID,
        signedTx: '0xabcd' as Hex,
        txHash: TX_HASH,
      });
      expect(result.kind).toBe('not-found');
    });

    it('markSigned wrong-state returns wrong-state with current row', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, BASE_ENQ);
      await markSigned(db, {
        id,
        expectedUserId: USER_ID,
        signedTx: '0xabcd' as Hex,
        txHash: TX_HASH,
      });
      const second = await markSigned(db, {
        id,
        expectedUserId: USER_ID,
        signedTx: '0xabcd' as Hex,
        txHash: TX_HASH,
      });
      expect(second.kind).toBe('wrong-state');
      if (second.kind === 'wrong-state') expect(second.current.status).toBe('signed');
    });

    it('markFailed CANNOT overwrite confirmed (terminal-state guard)', async () => {
      const { db, rows } = makeDb();
      const { id } = await enqueue(db, BASE_ENQ);
      if (rows[0]) {
        rows[0].status = 'confirmed';
        rows[0].blockNumber = 999n;
      }
      const result = await markFailed(db, {
        id,
        expectedUserId: USER_ID,
        error: 'late timeout',
      });
      expect(result.kind).toBe('wrong-state');
      if (result.kind === 'wrong-state') expect(result.current.status).toBe('confirmed');
      expect(rows[0]?.status).toBe('confirmed');
    });

    it('markConfirmed from failed state returns wrong-state (no resurrection)', async () => {
      const { db, rows } = makeDb();
      const { id } = await enqueue(db, BASE_ENQ);
      await markFailed(db, { id, expectedUserId: USER_ID, error: 'early fail' });
      if (rows[0]) rows[0].status = 'failed';
      const result = await markConfirmed(db, {
        id,
        expectedUserId: USER_ID,
        blockNumber: 1n,
      });
      expect(result.kind).toBe('wrong-state');
    });

    it('markFailed empty error string rejected', async () => {
      const { db } = makeDb();
      const { id } = await enqueue(db, BASE_ENQ);
      await expect(markFailed(db, { id, expectedUserId: USER_ID, error: '' })).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
      );
    });
  });

  describe('proposeForUser', () => {
    it('enqueues and emits eoa.proposal.pending', async () => {
      const { db } = makeDb();
      const events = { emit: vi.fn().mockResolvedValue(undefined) };
      const result = await proposeForUser({ db, txParams: BASE_ENQ, events });
      expect(result.queueId).toMatch(/^[0-9a-f-]{36}$/);
      expect(events.emit).toHaveBeenCalledWith(
        'eoa.proposal.pending',
        expect.objectContaining({ queueId: result.queueId, agentId: AGENT_A }),
      );
    });

    it('emit failure non-fatal — row enqueued, apikey redacted in log', async () => {
      const { db, rows } = makeDb();
      const events = {
        emit: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'publish failed at https://emit.example/x?apikey=FAKE_TEST_FIXTURE_NOT_A_KEY',
            ),
          ),
      };
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await proposeForUser({ db, txParams: BASE_ENQ, events });
      expect(result.queueId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]?.status).toBe('pending');
      const callArgs = errSpy.mock.calls[0];
      expect(callArgs?.[1]).toMatchObject({ error: expect.stringContaining('<redacted>') });
      expect(JSON.stringify(callArgs)).not.toContain('FAKE_TEST_FIXTURE_NOT_A_KEY');
      errSpy.mockRestore();
    });
  });
});
