import { vi } from 'vitest';
import type { AgentState, Plan } from '../../types.ts';
import type { ProposalPublisher, ProposalRepository } from '../propose.ts';
import type { DetailedSim } from '../simulate.ts';

export const STATE: AgentState = {
  agentId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  chain: 'mantle-sepolia',
  goal: 'idle yield',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};
export const TICK_ID = '00000000-0000-0000-0000-000000000003';
export const PROPOSAL_ID = '00000000-0000-0000-0000-000000000004';
export const NOW = new Date('2026-06-13T10:00:00Z');

export const HF_BEFORE = 2_000_000_000_000_000_000n;
export const HF_HEALTHY = 1_900_000_000_000_000_000n;
export const HF_FLOOR = 1_500_000_000_000_000_000n;
export const HF_NEAR_FLOOR = 1_550_000_000_000_000_000n;

export function simOf(healthFactorAfter: bigint, warnings: string[] = []): DetailedSim {
  return {
    ok: true,
    gasEstimateWei: 100_000n,
    expectedValueDeltaUsd: null,
    warnings,
    deltaState: {
      healthFactorBefore: HF_BEFORE,
      healthFactorAfter,
      balanceDeltas: Object.freeze({}),
      debtDeltas: Object.freeze({}),
      oracleChecks: Object.freeze({ stale: false }),
    },
  };
}

export const PLAN: Plan = {
  intent: 'rebalance',
  providerCalls: [{ provider: 'aave', action: 'supply', args: {} }],
};

export function makeRepo(over: Partial<ProposalRepository> = {}): ProposalRepository {
  return {
    findPendingByAgent: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue({ id: PROPOSAL_ID }),
    ...over,
  };
}

export function makePub(): ProposalPublisher & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue(undefined);
  return { publish: mock, mock };
}
