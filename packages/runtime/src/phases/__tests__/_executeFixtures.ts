import { vi } from 'vitest';
import type { AgentState } from '../../types.ts';
import type {
  ApprovedProposal,
  EoaQueueEnqueue,
  ExecutionRepository,
  ExecutorClient,
  SessionKeyLoader,
  UserOpReceipt,
} from '../execute.ts';
import type { ExecutionRow } from '../executeSchema.ts';

export const STATE: AgentState = {
  agentId: 'agent-1',
  userId: 'user-1',
  chain: 'mantle-sepolia',
  goal: 'idle yield',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};

export const PROPOSAL: ApprovedProposal = {
  id: 'prop-1',
  txParams: [{ to: '0xabc', data: '0xdeadbeef', value: '0' }],
  gasEstimateWei: 100_000n,
};

export const USER_OP = `0x${'a'.repeat(64)}`;
export const TX_HASH = `0x${'b'.repeat(64)}`;

export function withKey(): SessionKeyLoader {
  return { load: vi.fn().mockResolvedValue({ kind: 'present' }) };
}
export function noKey(): SessionKeyLoader {
  return { load: vi.fn().mockResolvedValue({ kind: 'missing' }) };
}

export function makeExecutor(
  receipt: UserOpReceipt | null,
  over: Partial<ExecutorClient> = {},
): ExecutorClient {
  return {
    submit: vi.fn().mockResolvedValue({ userOpHash: USER_OP }),
    waitForReceipt: vi.fn().mockResolvedValue(receipt),
    ...over,
  };
}

export function makeRepo(): ExecutionRepository & { rows: ExecutionRow[] } {
  const rows: ExecutionRow[] = [];
  return {
    rows,
    insert: vi.fn().mockImplementation(async (row: ExecutionRow) => {
      rows.push(row);
      return { id: `exec-${rows.length}` };
    }),
  };
}

export function makeQueue(): EoaQueueEnqueue {
  return { enqueue: vi.fn().mockResolvedValue({ queueId: 'q-1' }) };
}

export function okReceipt(over: Partial<{ gasUsedActual: bigint }> = {}): UserOpReceipt {
  return {
    success: true,
    userOpHash: USER_OP,
    txHash: TX_HASH,
    blockNumber: 100n,
    gasUsedActual: 100_000n,
    ...over,
  };
}

export function revertReceipt(revertReason = 'INSUFFICIENT'): UserOpReceipt {
  return {
    success: false,
    userOpHash: USER_OP,
    txHash: TX_HASH,
    blockNumber: 100n,
    gasUsedActual: 50_000n,
    revertReason,
  };
}
