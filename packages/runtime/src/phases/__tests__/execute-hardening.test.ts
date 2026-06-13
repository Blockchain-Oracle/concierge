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
  STATE,
  USER_OP,
  withKey,
} from './_executeFixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('runExecute — round-1 hardening', () => {
  it('CWE-117: executor returns malformed userOpHash → InvariantViolation', async () => {
    const executor = makeExecutor(null, {
      submit: vi.fn().mockResolvedValue({ userOpHash: '0xnotahash\nINJECTED' }),
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
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
    );
  });

  it('AbortSignal fires between submit and waitForReceipt → timeout row preserves userOpHash', async () => {
    const ctl = new AbortController();
    const repo = makeRepo();
    const executor = makeExecutor(null, {
      submit: vi.fn().mockImplementation(async () => {
        ctl.abort();
        return { userOpHash: USER_OP };
      }),
      waitForReceipt: vi.fn(), // MUST NOT be called
    });
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor,
        sessionKey: withKey(),
        repository: repo,
        eoaQueue: makeQueue(),
        abortSignal: ctl.signal,
      },
    );
    if (out.kind === 'continue' && out.data.status === 'timeout') {
      expect(out.data.userOpHash).toBe(USER_OP);
    } else {
      throw new Error('expected timeout');
    }
    expect(executor.waitForReceipt).not.toHaveBeenCalled();
    expect(repo.rows[0]?.status).toBe('timeout');
  });

  it('EOA orphan reconciliation: enqueue succeeds, insert fails → error metadata carries queueId', async () => {
    const queue = makeQueue();
    const repo: ExecutionRepository = {
      insert: vi.fn().mockRejectedValue(new Error('insert exploded')),
    };
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor: makeExecutor(null),
          sessionKey: noKey(),
          repository: repo,
          eoaQueue: queue,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const md = e.metadata as
        | { queueId?: unknown; proposalId?: unknown; agentId?: unknown }
        | undefined;
      return (
        e.type === 'RpcError' &&
        md?.queueId === 'q-1' &&
        md?.proposalId === 'prop-1' &&
        md?.agentId === 'agent-1'
      );
    });
  });

  it('drift threshold boundary: actual = 120_000n (exactly 20%) → no log', async () => {
    const driftLog = vi.fn();
    await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(okReceipt({ gasUsedActual: 120_000n })),
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
        logDrift: driftLog,
      },
    );
    // strict > means 20% itself does NOT log
    expect(driftLog).not.toHaveBeenCalled();
  });

  it('drift threshold boundary: actual = 120_100n (just over 20%) → log fires', async () => {
    const driftLog = vi.fn();
    await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor: makeExecutor(okReceipt({ gasUsedActual: 120_100n })),
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
        logDrift: driftLog,
      },
    );
    expect(driftLog).toHaveBeenCalledTimes(1);
  });
});

describe('runExecute — round-2 hardening', () => {
  it('userOpHash normalized to lowercase before persist + interpolate', async () => {
    const mixed = `0x${'A'.repeat(64)}`;
    const repo = makeRepo();
    const executor = makeExecutor(null, {
      submit: vi.fn().mockResolvedValue({ userOpHash: mixed }),
      waitForReceipt: vi.fn().mockResolvedValue(null),
    });
    const out = await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor,
        sessionKey: withKey(),
        repository: repo,
        eoaQueue: makeQueue(),
      },
    );
    if (out.kind === 'continue' && out.data.status === 'timeout') {
      expect(out.data.userOpHash).toBe(mixed.toLowerCase());
      expect(repo.rows[0]?.userOpHash).toBe(mixed.toLowerCase());
    } else {
      throw new Error('expected timeout');
    }
  });

  it('insertOrThrow on timeout carries userOpHash + proposalId in metadata', async () => {
    const repo: ExecutionRepository = {
      insert: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const executor = makeExecutor(null);
    await expect(
      runExecute(
        { state: STATE, proposal: PROPOSAL },
        {
          executor,
          sessionKey: withKey(),
          repository: repo,
          eoaQueue: makeQueue(),
        },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const md = e.metadata as
        | { userOpHash?: unknown; proposalId?: unknown; agentId?: unknown }
        | undefined;
      return (
        e.type === 'RpcError' &&
        md?.userOpHash === USER_OP &&
        md?.proposalId === 'prop-1' &&
        md?.agentId === 'agent-1'
      );
    });
  });

  it('UserOpReceipt success variant is structurally distinct from failure (compile-time)', () => {
    // Type-only assert — a success:true value cannot carry revertReason.
    type _SuccessHasNoRevert =
      Extract<UserOpReceipt, { success: true }> extends {
        revertReason: unknown;
      }
        ? false
        : true;
    const check: _SuccessHasNoRevert = true;
    expect(check).toBe(true);
  });

  it('abort-after-submit emits orphan_on_bundler signal via logDrift', async () => {
    const ctl = new AbortController();
    const driftLog = vi.fn();
    const executor = makeExecutor(null, {
      submit: vi.fn().mockImplementation(async () => {
        ctl.abort();
        return { userOpHash: USER_OP };
      }),
      waitForReceipt: vi.fn(),
    });
    await runExecute(
      { state: STATE, proposal: PROPOSAL },
      {
        executor,
        sessionKey: withKey(),
        repository: makeRepo(),
        eoaQueue: makeQueue(),
        abortSignal: ctl.signal,
        logDrift: driftLog,
      },
    );
    expect(driftLog).toHaveBeenCalledWith(expect.stringContaining('orphan_on_bundler'));
  });
});
