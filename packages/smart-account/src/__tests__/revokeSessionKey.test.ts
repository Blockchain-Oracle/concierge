import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeSessionKey } from '../revokeSessionKey.ts';
import { makeDb } from './_revokeStub.ts';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';
const SK_1 = '33333333-3333-4333-8333-333333333333';
const SK_MISSING = '55555555-5555-4555-8555-555555555555';
const SK_ADDR_A = '0x1111111111111111111111111111111111111111' as Address;
const TX_HASH = '0xabc' as Hex;

describe('revokeSessionKey (story-54)', () => {
  let onChainRevoker: ReturnType<typeof vi.fn>;
  let events: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    onChainRevoker = vi.fn().mockResolvedValue({ txHash: TX_HASH });
    events = { emit: vi.fn().mockResolvedValue(undefined) };
  });

  it('happy path: UPDATE → on-chain → event emit', async () => {
    const { db, rows } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    const result = await revokeSessionKey({
      db,
      sessionKeyId: SK_1,
      expectedAgentId: AGENT_ID,
      onChainRevoker,
      events,
    });
    expect(result.onChainTxHash).toBe(TX_HASH);
    expect(result.agentId).toBe(AGENT_ID);
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
    expect(onChainRevoker).toHaveBeenCalledWith({ sessionKeyAddress: SK_ADDR_A });
    expect(events.emit).toHaveBeenCalledWith('agent.revoked', {
      sessionKeyId: SK_1,
      agentId: AGENT_ID,
      revokedAt: expect.any(Date),
    });
  });

  it('idempotent re-revoke: returns existing revokedAt and does NOT re-attempt on-chain', async () => {
    const past = new Date(Date.now() - 60_000);
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: past },
    ]);
    const result = await revokeSessionKey({
      db,
      sessionKeyId: SK_1,
      expectedAgentId: AGENT_ID,
      onChainRevoker,
    });
    expect(result.revokedAt.getTime()).toBe(past.getTime());
    expect(result.onChainTxHash).toBeNull();
    expect(onChainRevoker).not.toHaveBeenCalled();
  });

  it('throws SessionKeyNotFound when id is unknown', async () => {
    const { db } = makeDb([]);
    await expect(
      revokeSessionKey({
        db,
        sessionKeyId: SK_MISSING,
        expectedAgentId: AGENT_ID,
        onChainRevoker,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'SessionKeyNotFound',
    );
    expect(onChainRevoker).not.toHaveBeenCalled();
  });

  it('throws NotAuthorized when expectedAgentId does not own the session key (IDOR defense)', async () => {
    const { db, rows } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    await expect(
      revokeSessionKey({
        db,
        sessionKeyId: SK_1,
        expectedAgentId: OTHER_AGENT_ID,
        onChainRevoker,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'NotAuthorized');
    expect(rows[0]?.revokedAt).toBeNull();
    expect(onChainRevoker).not.toHaveBeenCalled();
  });

  it('throws ConfigError when sessionKeyId is not a valid UUID', async () => {
    const { db } = makeDb([]);
    await expect(
      revokeSessionKey({
        db,
        sessionKeyId: 'not-a-uuid',
        expectedAgentId: AGENT_ID,
        onChainRevoker,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('DB UPDATE throw: error propagates and on-chain is NOT attempted', async () => {
    const handle = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    handle.failNextUpdate(new Error('connection terminated'));
    await expect(
      revokeSessionKey({
        db: handle.db,
        sessionKeyId: SK_1,
        expectedAgentId: AGENT_ID,
        onChainRevoker,
      }),
    ).rejects.toThrow(/connection terminated/);
    expect(onChainRevoker).not.toHaveBeenCalled();
  });

  it('retries on-chain step once before succeeding', async () => {
    onChainRevoker
      .mockRejectedValueOnce(new Error('rpc blip'))
      .mockResolvedValueOnce({ txHash: TX_HASH });
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    const result = await revokeSessionKey({
      db,
      sessionKeyId: SK_1,
      expectedAgentId: AGENT_ID,
      onChainRevoker,
      onChainBackoffMs: 0,
    });
    expect(result.onChainTxHash).toBe(TX_HASH);
    expect(onChainRevoker).toHaveBeenCalledTimes(2);
  });

  it('RevocationPartialFailure: cause is AggregateError preserving every attempt', async () => {
    onChainRevoker
      .mockRejectedValueOnce(new Error('revert: validator not installed'))
      .mockRejectedValueOnce(new Error('bundler timeout'));
    const { db, rows } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    let captured: ConciergeError | undefined;
    try {
      await revokeSessionKey({
        db,
        sessionKeyId: SK_1,
        expectedAgentId: AGENT_ID,
        onChainRevoker,
        onChainBackoffMs: 0,
      });
    } catch (e) {
      captured = e as ConciergeError;
    }
    expect(captured).toBeInstanceOf(ConciergeError);
    expect(captured?.type).toBe('RevocationPartialFailure');
    expect(captured?.metadata?.['dbRevoked']).toBe(true);
    expect(captured?.metadata?.['onChainRevoked']).toBe(false);
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
    const agg = captured?.cause as AggregateError;
    expect(agg).toBeInstanceOf(AggregateError);
    expect(agg.errors).toHaveLength(2);
    expect((agg.errors[0] as Error).message).toMatch(/revert/);
    expect((agg.errors[1] as Error).message).toMatch(/timeout/);
  });

  it('AggregateError attempts survive ConciergeError.toJSON via causeSummary', async () => {
    onChainRevoker
      .mockRejectedValueOnce(new Error('revert: validator not installed'))
      .mockRejectedValueOnce(new Error('bundler timeout'));
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    let captured: ConciergeError | undefined;
    try {
      await revokeSessionKey({
        db,
        sessionKeyId: SK_1,
        expectedAgentId: AGENT_ID,
        onChainRevoker,
        onChainBackoffMs: 0,
      });
    } catch (e) {
      captured = e as ConciergeError;
    }
    const json = captured?.toJSON();
    const summary = json?.['causeSummary'] as {
      kind: string;
      attempts: { name: string; message: string }[];
    };
    expect(summary?.kind).toBe('AggregateError');
    expect(summary?.attempts).toHaveLength(2);
    expect(summary?.attempts[0]?.message).toMatch(/revert/);
    expect(summary?.attempts[1]?.message).toMatch(/timeout/);
  });

  it('scrubLeakage redacts apiKey/token query params from retry errors before AggregateError', async () => {
    const leakyMsg =
      'Pimlico 401 from https://api.pimlico.io/v2/mantle/rpc?apikey=FAKE_TEST_FIXTURE_NOT_A_KEY&otherparam=ok';
    onChainRevoker.mockRejectedValue(new Error(leakyMsg));
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    let captured: ConciergeError | undefined;
    try {
      await revokeSessionKey({
        db,
        sessionKeyId: SK_1,
        expectedAgentId: AGENT_ID,
        onChainRevoker,
        onChainBackoffMs: 0,
      });
    } catch (e) {
      captured = e as ConciergeError;
    }
    const agg = captured?.cause as AggregateError;
    expect(agg).toBeInstanceOf(AggregateError);
    for (const e of agg.errors as Error[]) {
      expect(e.message).not.toContain('FAKE_TEST_FIXTURE_NOT_A_KEY');
      expect(e.message).toContain('<redacted>');
      expect(e.message).toContain('otherparam=ok');
    }
  });

  it('rejects onChainMaxAttempts < 1 with ConfigError', async () => {
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    await expect(
      revokeSessionKey({
        db,
        sessionKeyId: SK_1,
        expectedAgentId: AGENT_ID,
        onChainRevoker,
        onChainMaxAttempts: 0,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('event emit failure: non-fatal — revocation succeeds, error logged to stderr', async () => {
    events.emit.mockRejectedValue(new Error('redis down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    const result = await revokeSessionKey({
      db,
      sessionKeyId: SK_1,
      expectedAgentId: AGENT_ID,
      onChainRevoker,
      events,
    });
    expect(result.onChainTxHash).toBe(TX_HASH);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('agent.revoked emit failed'),
      expect.objectContaining({ sessionKeyId: SK_1, agentId: AGENT_ID }),
    );
    errSpy.mockRestore();
  });
});
