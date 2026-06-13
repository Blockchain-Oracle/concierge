import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../tick.ts';
import type {
  ExecuteFn,
  PhaseOutcome,
  PlanFn,
  Proposal,
  ProposeFn,
  RecordFn,
  SimulateFn,
  TickConfig,
} from '../../types.ts';
import { AGENT_ID, makeFakes, makeLock, NOW, STATE } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e ManualApprovalTick — propose pauses → user approves → follow-up tick completes', () => {
  it('shared state across two ticks: tick #1 stops at propose; tick #2 (post-approval) completes', async () => {
    // Round-1 fix: single shared-state lifecycle. A mutable `approvalState`
    // flag flips between tick #1 (stop:awaiting_approval) and tick #2
    // (continue with non-null proposal). Removes the prior "second it()
    // proves nothing" false-confidence.
    const fakes = makeFakes();
    const PROPOSAL_ID = 'prop-approval';
    const approvalState = { approved: false };

    const plan: PlanFn = vi.fn().mockResolvedValue({
      kind: 'continue',
      data: {
        intent: 'rebalance',
        providerCalls: [{ provider: 'aave', action: 'supply', args: { amount: '100' } }],
      },
    });
    const simulate: SimulateFn = vi.fn().mockResolvedValue({
      kind: 'continue',
      data: { ok: true, gasEstimateWei: 250_000n, expectedValueDeltaUsd: 1, warnings: [] },
    });
    const propose: ProposeFn = vi
      .fn()
      .mockImplementation(async (): Promise<PhaseOutcome<Proposal>> => {
        if (!approvalState.approved) {
          return { kind: 'stop', reason: 'awaiting_approval' };
        }
        return {
          kind: 'continue',
          data: {
            id: PROPOSAL_ID,
            requiresApproval: true,
            summary: 'supply 100 USDC',
            txParams: [{ to: '0xaave', data: '0xdeadbeef', value: '0' }],
          },
        };
      });
    const execute: ExecuteFn = vi.fn().mockImplementation(async (_state, proposal) => {
      fakes.executions.push({ proposalId: proposal.id, attestationUid: null });
      return {
        kind: 'continue',
        data: { txHashes: [`0x${'a'.repeat(64)}`], blockNumbers: [42n], gasUsed: 200_000n },
      };
    });
    const record: RecordFn = vi.fn().mockImplementation(async () => {
      const last = fakes.executions.at(-1);
      const uid = `0x${'c'.repeat(64)}`;
      if (last !== undefined) last.attestationUid = uid;
      fakes.attestationsAttempted.push(uid);
      return { kind: 'continue', data: { attestationUid: uid, recordedAt: NOW } };
    });

    const config: TickConfig = {
      agentId: AGENT_ID,
      loadState: vi.fn().mockResolvedValue(STATE),
      plan,
      simulate,
      propose,
      execute,
      record,
      lock: makeLock(fakes),
      lockTtlMs: 60_000,
    };

    // Tick #1 — awaiting approval; downstream phases NOT invoked.
    const r1 = await tick(config);
    expect(r1.kind).toBe('stopped');
    if (r1.kind !== 'stopped') throw new Error('expected stopped');
    expect(r1.phase).toBe('propose');
    expect(r1.reason).toBe('awaiting_approval');
    expect(execute).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(fakes.executions).toHaveLength(0);

    // ↓ User clicks "approve" out-of-band.
    approvalState.approved = true;

    // Tick #2 — propose now continues; execute + record run.
    const r2 = await tick(config);
    expect(r2.kind).toBe('completed');
    if (r2.kind !== 'completed') throw new Error('expected completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(fakes.executions).toHaveLength(1);
    expect(fakes.executions[0]?.proposalId).toBe(PROPOSAL_ID);
    expect(fakes.executions[0]?.attestationUid).toBe(r2.attestation.attestationUid);
  });
});
