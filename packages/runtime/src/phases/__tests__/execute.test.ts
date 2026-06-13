import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type EoaQueueEnqueue,
  type ExecutionRepository,
  runExecute,
  type SessionKeyLoader,
  type UserOpReceipt,
} from '../execute.ts';
import {
  makeExecutor,
  makeQueue,
  makeRepo,
  noKey,
  okReceipt,
  PROPOSAL,
  revertReceipt,
  STATE,
  TX_HASH,
  USER_OP,
  withKey,
} from './_executeFixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('runExecute — happy path', () => {
  it('confirmed: submits, waits, returns confirmed with gas drift', async () => {
    const repo = makeRepo();
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(okReceipt({ gasUsedActual: 110_000n })),
        sessionKey: withKey(),
        repository: repo,
        eoaQueue: makeQueue(),
      },
    );
    expect(out.kind).toBe('continue');
    if (out.kind !== 'continue') return;
    expect(out.data.status).toBe('confirmed');
    if (out.data.status !== 'confirmed') return;
    expect(out.data.userOpHash).toBe(USER_OP);
    expect(out.data.txHash).toBe(TX_HASH);
    expect(out.data.gasUsedActual).toBe(110_000n);
    expect(out.data.gasEstimateDriftPct).toBeCloseTo(10, 0);
    expect(repo.rows[0]?.status).toBe('confirmed');
  });

  it('logs gas_estimate_drift when > 20%', async () => {
    const driftLog = vi.fn();
    await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(okReceipt({ gasUsedActual: 200_000n })),
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
        logDrift: driftLog,
      },
    );
    expect(driftLog).toHaveBeenCalledWith(expect.stringContaining('gas_estimate_drift'));
  });

  it('does NOT log drift when within 20%', async () => {
    const driftLog = vi.fn();
    await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(okReceipt({ gasUsedActual: 115_000n })),
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
        logDrift: driftLog,
      },
    );
    expect(driftLog).not.toHaveBeenCalled();
  });
});

describe('runExecute — domain failure outcomes', () => {
  it('tx_reverted: receipt.success=false → status tx_reverted with revertReason', async () => {
    const repo = makeRepo();
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(revertReceipt('INSUFFICIENT')),
        sessionKey: withKey(),
        repository: repo,
        eoaQueue: makeQueue(),
      },
    );
    if (out.kind === 'continue' && out.data.status === 'tx_reverted') {
      expect(out.data.revertReason).toBe('INSUFFICIENT');
      expect(repo.rows[0]?.revertReason).toBe('INSUFFICIENT');
    } else {
      throw new Error('expected tx_reverted');
    }
  });

  it('timeout: waitForReceipt returns null → status timeout (userOpHash preserved)', async () => {
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(null),
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
      },
    );
    if (out.kind === 'continue' && out.data.status === 'timeout') {
      expect(out.data.userOpHash).toBe(USER_OP);
    } else {
      throw new Error('expected timeout');
    }
  });

  it('session_key_expired: submit throws SessionKeyExpired → status session_key_expired', async () => {
    const executor = makeExecutor(null, {
      submit: vi.fn().mockRejectedValue(new ConciergeError('SessionKeyExpired', 'expired')),
    });
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor,
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
      },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') {
      expect(out.data.status).toBe('session_key_expired');
    } else {
      throw new Error('expected continue');
    }
  });

  it('SessionKeyPolicyRejected: submit throws → rethrown as ConciergeError', async () => {
    const executor = makeExecutor(null, {
      submit: vi.fn().mockRejectedValue(new ConciergeError('SessionKeyPolicyRejected', 'no perm')),
    });
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor,
          sessionKey: withKey(),
          repository: makeRepo(),
          eoaQueue: makeQueue(),
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'SessionKeyPolicyRejected',
    );
  });
});

describe('runExecute — EOA fallback', () => {
  it('no session key → enqueues + returns awaiting_user_signature', async () => {
    const queue = makeQueue();
    const repo = makeRepo();
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(null),
        sessionKey: noKey(),
        repository: repo,
        eoaQueue: queue,
      },
    );
    expect(queue.enqueue).toHaveBeenCalledWith({ proposalId: 'prop-1', agentId: 'agent-1' });
    if (out.kind === 'continue' && out.data.status === 'awaiting_user_signature') {
      expect(out.data.queueId).toBe('q-1');
      expect(repo.rows[0]?.status).toBe('awaiting_user_signature');
    } else {
      throw new Error('expected awaiting_user_signature');
    }
  });

  it('EOA enqueue throws → ConciergeError(RpcError) with sanitized cause', async () => {
    const queue: EoaQueueEnqueue = {
      enqueue: vi.fn().mockRejectedValue(new Error('queue down at ?apikey=LEAK')),
    };
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor: makeExecutor(null),
          sessionKey: noKey(),
          repository: makeRepo(),
          eoaQueue: queue,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      return e.type === 'RpcError' && !JSON.stringify(e).includes('LEAK');
    });
  });
});

describe('runExecute — infra failures (THROW)', () => {
  it('waitForReceipt throws → RpcError preserves userOpHash for late polling', async () => {
    const executor = makeExecutor(null, {
      waitForReceipt: vi.fn().mockRejectedValue(new Error('rpc dropped')),
    });
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor,
          sessionKey: withKey(),
          repository: makeRepo(),
          eoaQueue: makeQueue(),
        },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'RpcError' && e.message.includes(USER_OP),
    );
  });

  it('sessionKey.load throws → RpcError', async () => {
    const sk: SessionKeyLoader = {
      load: vi.fn().mockRejectedValue(new Error('db down')),
    };
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor: makeExecutor(null),
          sessionKey: sk,
          repository: makeRepo(),
          eoaQueue: makeQueue(),
        },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('execution-row insert throws → RpcError', async () => {
    const repo: ExecutionRepository = {
      insert: vi.fn().mockRejectedValue(new Error('insert blew up')),
    };
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor: makeExecutor(okReceipt()),
          sessionKey: withKey(),
          repository: repo,
          eoaQueue: makeQueue(),
        },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});

describe('runExecute — boundary validation', () => {
  it('empty txParams → InvariantViolation', async () => {
    await expect(
      runExecute(
        { state: STATE, proposal: { ...PROPOSAL, txParams: [] } },
        {
          executor: makeExecutor(null),
          sessionKey: withKey(),
          repository: makeRepo(),
          eoaQueue: makeQueue(),
        },
      ),
    ).rejects.toBeInstanceOf(ConciergeError);
  });

  it('waitTimeoutMs below floor → InvariantViolation', async () => {
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor: makeExecutor(null),
          sessionKey: withKey(),
          repository: makeRepo(),
          eoaQueue: makeQueue(),
          waitTimeoutMs: 100,
        },
      ),
    ).rejects.toBeInstanceOf(ConciergeError);
  });
});
