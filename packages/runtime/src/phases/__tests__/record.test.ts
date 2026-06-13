import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AttestationRetryQueue,
  type Erc8004Client,
  type ExecutionAttestationRepository,
  type RecordLogEntry,
  runRecord,
} from '../record.ts';
import { runRecordFallback } from '../recordFallback.ts';
import {
  ATTEST_TX,
  ATTEST_UID,
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

describe('runRecord — happy path', () => {
  it('attests + attaches uid; returns kind:"attested"', async () => {
    const repo = makeRepo();
    const out = await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester: makeAttester(),
        repository: repo,
        retryQueue: makeQueue(),
        now: () => NOW,
      },
    );
    expect(out.kind).toBe('continue');
    if (out.kind !== 'continue') throw new Error('expected continue');
    expect(out.data.kind).toBe('attested');
    if (out.data.kind !== 'attested') throw new Error('expected attested');
    expect(out.data.attestationUid).toBe(ATTEST_UID);
    expect(out.data.attestationTxHash).toBe(ATTEST_TX);
    expect(repo.attached).toHaveLength(1);
    expect(repo.attached[0]?.uid).toBe(ATTEST_UID);
  });

  it('mixed-case uid/txHash from chain → normalized to lowercase', async () => {
    const upperUid = `0x${'C'.repeat(64)}`;
    const upperTx = `0x${'D'.repeat(64)}`;
    const out = await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester: makeAttester({ attestationUid: upperUid, attestationTxHash: upperTx }),
        repository: makeRepo(),
        retryQueue: makeQueue(),
        now: () => NOW,
      },
    );
    if (out.kind === 'continue' && out.data.kind === 'attested') {
      expect(out.data.attestationUid).toBe(upperUid.toLowerCase());
      expect(out.data.attestationTxHash).toBe(upperTx.toLowerCase());
    } else {
      throw new Error('expected attested');
    }
  });

  it('logRecord emits structured entry with durationMs + outcome', async () => {
    const entries: RecordLogEntry[] = [];
    const t0 = new Date('2026-06-13T11:00:00.000Z');
    const t1 = new Date('2026-06-13T11:00:00.250Z');
    const t2 = new Date('2026-06-13T11:00:00.500Z');
    let calls = 0;
    const now = () => [t0, t1, t2][calls++] ?? t2;
    await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester: makeAttester(),
        repository: makeRepo(),
        retryQueue: makeQueue(),
        now,
        logRecord: (e) => entries.push(e),
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('attested');
    expect(entries[0]?.attestationUid).toBe(ATTEST_UID);
    expect(entries[0]?.txHash).toBe(EXEC.txHash);
    expect(entries[0]?.durationMs).toBeGreaterThan(0);
  });
});

describe('runRecord — idempotence', () => {
  it('row already has attestationUid → kind:"already_attested"; attestAction NOT called', async () => {
    const repo = makeRepo({ attestationUid: ATTEST_UID });
    const attester: Erc8004Client = makeAttester();
    const out = await runRecord(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester,
        repository: repo,
        retryQueue: makeQueue(),
        now: () => NOW,
      },
    );
    expect(out.kind).toBe('continue');
    if (out.kind !== 'continue') throw new Error('expected continue');
    expect(out.data.kind).toBe('already_attested');
    if (out.data.kind !== 'already_attested') throw new Error('expected already_attested');
    expect(out.data.attestationUid).toBe(ATTEST_UID);
    expect(attester.attestAction).not.toHaveBeenCalled();
    expect(repo.attached).toHaveLength(0);
  });
});

describe('runRecord — non-blocking retry on attest failure (ADR-004)', () => {
  it('attestAction throws → kind:"retry_queued" with jobId', async () => {
    const attester: Erc8004Client = {
      attestAction: vi.fn().mockRejectedValue(new Error('ReputationRegistry paused')),
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
    expect(queue.enqueue).toHaveBeenCalledWith({
      executionId: EXEC.executionId,
      proposalId: EXEC.proposalId,
      agentId: STATE.agentId,
    });
  });

  it('attestAction throws AND retry queue ALSO throws → RpcError with reconcile metadata', async () => {
    const attester: Erc8004Client = {
      attestAction: vi.fn().mockRejectedValue(new Error('attest failed')),
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
      const md = e.metadata as { executionId?: unknown; agentId?: unknown } | undefined;
      return (
        e.type === 'RpcError' &&
        md?.executionId === EXEC.executionId &&
        md?.agentId === STATE.agentId &&
        e.message.includes('manual reconcile')
      );
    });
  });
});

describe('runRecord — boundary validation', () => {
  it('malformed exec.txHash → InvariantViolation', async () => {
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: { ...EXEC, txHash: '0xnope' } },
        {
          builder: makeBuilder(),
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

  it('ERC-8004 returns malformed uid → InvariantViolation', async () => {
    const attester: Erc8004Client = makeAttester({ attestationUid: 'not-a-hash' });
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
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
    );
  });

  it('builder returns missing providerSchema → InvariantViolation', async () => {
    const builder = makeBuilder();
    // biome-ignore lint/suspicious/noExplicitAny: deliberate
    builder.build = vi.fn().mockResolvedValue({ payload: {} } as any);
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

describe('runRecord — infra failures (THROW)', () => {
  it('repository.getAttestation throws → RpcError with sanitized cause', async () => {
    const repo: ExecutionAttestationRepository = {
      getAttestation: vi.fn().mockRejectedValue(new Error('db at ?apikey=LEAK')),
      attachAttestation: vi.fn(),
    };
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester: makeAttester(),
          repository: repo,
          retryQueue: makeQueue(),
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      return e.type === 'RpcError' && !JSON.stringify(e).includes('LEAK');
    });
  });

  it('attachAttestation throws AFTER attestAction success → RpcError carrying uid for reconcile', async () => {
    const repo: ExecutionAttestationRepository = {
      getAttestation: vi.fn().mockResolvedValue({ attestationUid: null }),
      attachAttestation: vi.fn().mockRejectedValue(new Error('insert failed')),
    };
    await expect(
      runRecord(
        { state: STATE, tickId: TICK_ID, exec: EXEC },
        {
          builder: makeBuilder(),
          attester: makeAttester(),
          repository: repo,
          retryQueue: makeQueue(),
          now: () => NOW,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const md = e.metadata as { attestationUid?: unknown } | undefined;
      return e.type === 'RpcError' && md?.attestationUid === ATTEST_UID;
    });
  });

  it('builder.build throws → RpcError', async () => {
    const builder = makeBuilder();
    builder.build = vi.fn().mockRejectedValue(new Error('provider explosion'));
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
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});

describe('runRecordFallback — delegates to runRecord', () => {
  it('EOA-path call produces same outcome as direct runRecord call', async () => {
    const out = await runRecordFallback(
      { state: STATE, tickId: TICK_ID, exec: EXEC },
      {
        builder: makeBuilder(),
        attester: makeAttester(),
        repository: makeRepo(),
        retryQueue: makeQueue(),
        now: () => NOW,
      },
    );
    expect(out.kind).toBe('continue');
    if (out.kind !== 'continue') throw new Error('expected continue');
    expect(out.data.kind).toBe('attested');
  });
});
