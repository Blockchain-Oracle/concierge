import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../tick.ts';
import type {
  Attestation,
  ExecuteFn,
  PhaseOutcome,
  PlanFn,
  ProposeFn,
  RecordFn,
  SimulateFn,
  TickConfig,
} from '../../types.ts';
import { AGENT_ID, makeFakes, makeLock, NOW, STATE } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e AttestationFailureRetry — failed attest then retry attaches uid (round-1: shared state)', () => {
  it('tick #1 record errors → executions row exists w/o uid; tick #2 record OK → SAME row attached', async () => {
    // Round-1 fix: shared fakes + shared proposalId across both ticks so
    // the retry actually carries state. The fake `record` switches outcome
    // based on attestationsAttempted length (first call fails, second succeeds).
    const fakes = makeFakes();
    const PROPOSAL_ID = 'prop-retry';
    const successUid = `0x${'c'.repeat(64)}`;

    const plan: PlanFn = vi.fn().mockResolvedValue({
      kind: 'continue',
      data: {
        intent: 'rebalance',
        providerCalls: [{ provider: 'aave', action: 'supply', args: {} }],
      },
    });
    const simulate: SimulateFn = vi.fn().mockResolvedValue({
      kind: 'continue',
      data: { ok: true, gasEstimateWei: 100_000n, expectedValueDeltaUsd: 0, warnings: [] },
    });
    const propose: ProposeFn = vi.fn().mockResolvedValue({
      kind: 'continue',
      data: {
        id: PROPOSAL_ID,
        requiresApproval: false,
        summary: 's',
        txParams: [{ to: '0xaave', data: '0xdead', value: '0' }],
      },
    });
    const execute: ExecuteFn = vi.fn().mockImplementation(async (_state, proposal) => {
      // Idempotent: only insert one row per proposalId across retries.
      if (!fakes.executions.some((e) => e.proposalId === proposal.id)) {
        fakes.executions.push({ proposalId: proposal.id, attestationUid: null });
      }
      return {
        kind: 'continue',
        data: { txHashes: [`0x${'a'.repeat(64)}`], blockNumbers: [1n], gasUsed: 100_000n },
      };
    });
    let recordCalls = 0;
    const record: RecordFn = vi
      .fn()
      .mockImplementation(async (): Promise<PhaseOutcome<Attestation>> => {
        recordCalls += 1;
        fakes.attestationsAttempted.push(`attempt-${recordCalls}`);
        if (recordCalls === 1) {
          return {
            kind: 'error',
            error: new Error('ReputationRegistry paused'),
            cause: 'returned',
          };
        }
        const row = fakes.executions.find((e) => e.proposalId === PROPOSAL_ID);
        if (row !== undefined) row.attestationUid = successUid;
        return { kind: 'continue', data: { attestationUid: successUid, recordedAt: NOW } };
      });

    const baseConfig: TickConfig = {
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

    // Tick #1 — record errors.
    const r1 = await tick(baseConfig);
    expect(r1.kind).toBe('errored');
    if (r1.kind !== 'errored') throw new Error('expected errored');
    expect(r1.phase).toBe('record');
    expect(fakes.executions).toHaveLength(1);
    expect(fakes.executions[0]?.proposalId).toBe(PROPOSAL_ID);
    expect(fakes.executions[0]?.attestationUid).toBeNull();
    expect(fakes.attestationsAttempted).toHaveLength(1);

    // Tick #2 — same proposal id, record succeeds, SAME row gets the uid.
    const r2 = await tick(baseConfig);
    expect(r2.kind).toBe('completed');
    if (r2.kind !== 'completed') throw new Error('expected completed');
    expect(r2.attestation.attestationUid).toBe(successUid);
    expect(fakes.executions).toHaveLength(1); // still ONE row (idempotent)
    expect(fakes.executions[0]?.attestationUid).toBe(successUid);
    expect(fakes.attestationsAttempted).toHaveLength(2);
  });
});
