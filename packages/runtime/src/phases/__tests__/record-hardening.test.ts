import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AttestationRetryQueue,
  type Erc8004Client,
  type RecordLogEntry,
  runRecord,
} from '../record.ts';
import { runRecordFallback } from '../recordFallback.ts';
import {
  EXEC,
  makeAttester,
  makeBuilder,
  makeQueue,
  makeRepo,
  NOW,
  STATE,
  TICK_ID,
} from './_recordFixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('runRecord — round-1 hardening', () => {
  it('attester throws a ConciergeError (provider impl detail) → still queues retry', async () => {
    // Round-1 fix: outer catch must NOT skip retry just because err is a
    // ConciergeError; only PostAttestInfraError + own InvariantViolation skip.
    const attester: Erc8004Client = {
      attestAction: vi
        .fn()
        .mockRejectedValue(new ConciergeError('RpcError', 'provider chose this type')),
    };
    const queue = makeQueue();
    const out = await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester,
        repository: makeRepo(),
        retryQueue: queue,
        now: () => NOW,
      },
    );
    if (out.kind === 'continue' && out.data.kind === 'retry_queued') {
      expect(out.data.retryJobId).toBe('retry-1');
    } else {
      throw new Error('expected retry_queued');
    }
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('retry-queue enqueue fail metadata includes proposalId + originalAttestCause', async () => {
    const attester: Erc8004Client = {
      attestAction: vi.fn().mockRejectedValue(new Error('chain hiccup specifically')),
    };
    const queue: AttestationRetryQueue = {
      enqueue: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester,
          repository: makeRepo(),
          retryQueue: queue,
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const md = e.metadata as { proposalId?: unknown; originalAttestCause?: unknown } | undefined;
      return (
        e.type === 'RpcError' &&
        md?.proposalId === EXEC.proposalId &&
        typeof md?.originalAttestCause === 'string' &&
        md.originalAttestCause.includes('chain hiccup')
      );
    });
  });

  it('malformed uid from chain: InvariantViolation message carries the raw uid for ops reconcile', async () => {
    const rawBadUid = 'totally-not-a-hash-but-something';
    const attester: Erc8004Client = makeAttester({ attestationUid: rawBadUid });
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester,
          repository: makeRepo(),
          retryQueue: makeQueue(),
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'InvariantViolation' &&
        e.message.includes(rawBadUid),
    );
  });

  it('logRecord opt-out: omitting logRecord does NOT throw on any path', async () => {
    const out = await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester: makeAttester(),
        repository: makeRepo(),
        retryQueue: makeQueue(),
        now: () => NOW,
        // logRecord intentionally omitted
      },
    );
    expect(out.kind).toBe('continue');
    if (out.kind !== 'continue') throw new Error('expected continue');
    expect(out.data.kind).toBe('attested');
  });

  it('logRecord fires on retry_queued outcome too (observability)', async () => {
    const entries: RecordLogEntry[] = [];
    const attester: Erc8004Client = {
      attestAction: vi.fn().mockRejectedValue(new Error('rpc')),
    };
    await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester,
        repository: makeRepo(),
        retryQueue: makeQueue(),
        now: () => NOW,
        logRecord: (e) => entries.push(e),
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('retry_queued');
    expect(entries[0]?.attestationUid).toBeNull();
  });

  it('builder payload propagates verbatim into attestAction', async () => {
    const custom = {
      providerSchema: 'concierge.lifi.bridge.v2',
      payload: { route: 'mantle->ethereum', amount: '1000' },
    };
    const builder = makeBuilder();
    builder.build = vi.fn().mockResolvedValue(custom);
    const attester = makeAttester();
    await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder,
        attester,
        repository: makeRepo(),
        retryQueue: makeQueue(),
        now: () => NOW,
      },
    );
    const callArgs = (attester.attestAction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs.providerSchema).toBe(custom.providerSchema);
    expect(callArgs.payload).toEqual(custom.payload);
  });

  it('runRecordFallback proves delegation: builder/attester from deps are actually called', async () => {
    const builder = makeBuilder();
    const attester = makeAttester();
    const repo = makeRepo();
    await runRecordFallback(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder,
        attester,
        repository: repo,
        retryQueue: makeQueue(),
        now: () => NOW,
      },
    );
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(attester.attestAction).toHaveBeenCalledTimes(1);
    expect(repo.attached).toHaveLength(1);
  });

  it('providerSchema regex: rejects an invalid id like "BadSchema"', async () => {
    const builder = makeBuilder();
    builder.build = vi.fn().mockResolvedValue({ providerSchema: 'BadSchema', payload: {} });
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder,
          attester: makeAttester(),
          repository: makeRepo(),
          retryQueue: makeQueue(),
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
    );
  });
});

describe('runRecord — round-2 hardening', () => {
  it('PostAttestInfra rethrow preserves the wrapped ConciergeError identity', async () => {
    const repo = makeRepo();
    repo.attachAttestation = vi.fn().mockRejectedValue(new Error('drizzle exploded'));
    let captured: unknown = null;
    try {
      await runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester: makeAttester(),
          repository: repo,
          retryQueue: makeQueue(),
          now: () => NOW,
        },
      );
    } catch (e) {
      captured = e;
    }
    if (!(captured instanceof ConciergeError)) throw new Error('expected ConciergeError');
    expect(captured.type).toBe('RpcError');
    // Confirm it's NOT the wrapper class itself — the marker was unwrapped.
    // Marker class unwrapped — captured is raw ConciergeError, not PostAttestInfraError.
    expect(captured.name).not.toBe('PostAttestInfraError');
    const md = captured.metadata as { attestationUid?: unknown } | undefined;
    expect(md?.attestationUid).toBeTruthy();
  });

  it('malformed uid: logRecord called BEFORE throw (order is observable)', async () => {
    const order: string[] = [];
    const attester: Erc8004Client = makeAttester({ attestationUid: 'definitely-not-hex' });
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester,
          repository: makeRepo(),
          retryQueue: makeQueue(),
          now: () => NOW,
          logRecord: () => order.push('log'),
        },
      ),
    ).rejects.toBeInstanceOf(ConciergeError);
    // The throw appends nothing to `order`; the log entry must already be there.
    expect(order).toEqual(['log']);
  });

  it('hostile toString on uid does NOT crash the throw path', async () => {
    const hostile: unknown = {
      toString() {
        throw new Error('mwahaha');
      },
    };
    const attester: Erc8004Client = makeAttester({
      // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile shape
      attestationUid: hostile as any,
    });
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester,
          repository: makeRepo(),
          retryQueue: makeQueue(),
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'InvariantViolation' &&
        e.message.includes('<unprintable>'),
    );
  });

  for (const bad of [
    'lifi', // single segment, no .vN
    'concierge.lifi.bridge', // no version suffix
    'concierge.aave.v0', // v0 rejected (round-2: v[1-9]\d*)
    'concierge.aave.v3.borrow.', // trailing dot
    '', // empty
    'Concierge.AAVE.v1', // uppercase
  ]) {
    it(`providerSchema regex: rejects '${bad}'`, async () => {
      const builder = makeBuilder();
      builder.build = vi.fn().mockResolvedValue({ providerSchema: bad, payload: {} });
      await expect(
        runRecord(
          { state: STATE, tickId: TICK_ID, exec: EXEC },
          {
            builder,
            attester: makeAttester(),
            repository: makeRepo(),
            retryQueue: makeQueue(),
            now: () => NOW,
          },
        ),
      ).rejects.toSatisfy(
        (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
      );
    });
  }

  it('originalAttestCause in retry-queue-fail metadata redacts Pimlico apikey URL', async () => {
    const attester: Erc8004Client = {
      attestAction: vi
        .fn()
        .mockRejectedValue(
          new Error('failed at https://api.pimlico.io/v2/rpc?apikey=SECRET_PIMLICO'),
        ),
    };
    const queue: AttestationRetryQueue = {
      enqueue: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester,
          repository: makeRepo(),
          retryQueue: queue,
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const serialized = JSON.stringify(e);
      return !serialized.includes('SECRET_PIMLICO');
    });
  });
});
