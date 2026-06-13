import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emergencyStop } from '../emergencyStop.ts';
import { makeDb } from './_revokeStub.ts';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const SK_1 = '33333333-3333-4333-8333-333333333333';
const SK_2 = '44444444-4444-4444-8444-444444444444';
const SK_ADDR_A = '0x1111111111111111111111111111111111111111' as Address;
const SK_ADDR_B = '0x2222222222222222222222222222222222222222' as Address;
const TX_HASH = '0xabc' as Hex;

describe('emergencyStop (story-54)', () => {
  let onChainRevoker: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChainRevoker = vi.fn().mockResolvedValue({ txHash: TX_HASH });
  });

  it('no active keys: returns empty result, does NOT throw', async () => {
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: new Date() },
    ]);
    const result = await emergencyStop({
      db,
      agentId: AGENT_ID,
      onChainRevoker,
    });
    expect(result.revoked).toHaveLength(0);
    expect(result.partialFailures).toHaveLength(0);
    expect(result.unexpectedFailures).toHaveLength(0);
    expect(onChainRevoker).not.toHaveBeenCalled();
  });

  it('revokes all active keys for the agent', async () => {
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
      { id: SK_2, agentId: AGENT_ID, publicAddress: SK_ADDR_B, revokedAt: null },
    ]);
    const result = await emergencyStop({
      db,
      agentId: AGENT_ID,
      onChainRevoker,
    });
    expect(result.revoked).toHaveLength(2);
    expect(result.partialFailures).toHaveLength(0);
    expect(result.unexpectedFailures).toHaveLength(0);
    expect(onChainRevoker).toHaveBeenCalledTimes(2);
  });

  it('isolates partial failures into partialFailures bucket — surviving keys still revoke', async () => {
    onChainRevoker.mockImplementation(
      async ({ sessionKeyAddress }: { sessionKeyAddress: Address }) => {
        if (sessionKeyAddress === SK_ADDR_B) throw new Error('rpc');
        return { txHash: TX_HASH };
      },
    );
    const { db } = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
      { id: SK_2, agentId: AGENT_ID, publicAddress: SK_ADDR_B, revokedAt: null },
    ]);
    const result = await emergencyStop({
      db,
      agentId: AGENT_ID,
      onChainRevoker,
    });
    expect(result.revoked).toHaveLength(1);
    expect(result.partialFailures).toHaveLength(1);
    expect(result.partialFailures[0]?.sessionKeyId).toBe(SK_2);
    expect(result.partialFailures[0]?.cause.type).toBe('RevocationPartialFailure');
    expect(result.unexpectedFailures).toHaveLength(0);
  });

  it('isolates UNEXPECTED failures (e.g. transient DB error) without aborting the fleet', async () => {
    const handle = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
      { id: SK_2, agentId: AGENT_ID, publicAddress: SK_ADDR_B, revokedAt: null },
    ]);
    // Intercept by WHERE argument (which is what production code routes on),
    // not by call order — Promise.allSettled offers no scheduling guarantees.
    const realUpdate = handle.db.update;
    handle.db.update = (...args: unknown[]) => {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      const chain = (realUpdate as any)(...args);
      return {
        // biome-ignore lint/suspicious/noExplicitAny: stub
        set: (patch: any) => ({
          where: (w: unknown) => {
            // Walk the WHERE for the target id literal — argument-based
            // intercept (deterministic) instead of call-order (raceable).
            const seen = new WeakSet<object>();
            let targetId: string | undefined;
            function walk(node: unknown): void {
              if (node === null || typeof node !== 'object') return;
              if (seen.has(node as object)) return;
              seen.add(node as object);
              // biome-ignore lint/suspicious/noExplicitAny: drizzle internals
              const n = node as any;
              if (typeof n.value === 'string' && n.value === SK_2) targetId = SK_2;
              if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) walk(c);
            }
            walk(w);
            if (targetId === SK_2) {
              return {
                returning: async () => {
                  throw new Error('connection terminated');
                },
              };
            }
            return chain.set(patch).where(w);
          },
        }),
      };
    };
    const result = await emergencyStop({
      db: handle.db,
      agentId: AGENT_ID,
      onChainRevoker,
    });
    expect(result.revoked).toHaveLength(1);
    expect(result.revoked[0]?.sessionKeyId).toBe(SK_1);
    expect(result.unexpectedFailures).toHaveLength(1);
    expect(result.unexpectedFailures[0]?.sessionKeyId).toBe(SK_2);
    expect(result.partialFailures).toHaveLength(0);
    expect((result.unexpectedFailures[0]?.cause as Error)?.message).toMatch(
      /connection terminated/,
    );
  });

  it('bounds concurrency to maxConcurrency (default 2) — avoids Pimlico + nonce hazards', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`,
      agentId: AGENT_ID,
      publicAddress: SK_ADDR_A,
      revokedAt: null as Date | null,
    }));
    const { db } = makeDb(rows);
    let inFlight = 0;
    let peak = 0;
    onChainRevoker.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { txHash: TX_HASH };
    });
    const result = await emergencyStop({
      db,
      agentId: AGENT_ID,
      onChainRevoker,
      maxConcurrency: 2,
    });
    expect(result.revoked).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('logs unexpected failures to stderr at push time', async () => {
    const handle = makeDb([
      { id: SK_1, agentId: AGENT_ID, publicAddress: SK_ADDR_A, revokedAt: null },
    ]);
    handle.db.update = () => ({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      set: (_p: any) => ({
        where: (_w: unknown) => ({
          returning: async () => {
            throw new Error('boom');
          },
        }),
      }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await emergencyStop({ db: handle.db, agentId: AGENT_ID, onChainRevoker });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('unexpected revocation failure'),
      expect.objectContaining({ agentId: AGENT_ID }),
    );
    errSpy.mockRestore();
  });

  it('throws ConfigError on invalid agentId UUID (boundary input validation)', async () => {
    const { db } = makeDb([]);
    await expect(
      emergencyStop({
        db,
        agentId: 'not-a-uuid',
        onChainRevoker,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });
});
