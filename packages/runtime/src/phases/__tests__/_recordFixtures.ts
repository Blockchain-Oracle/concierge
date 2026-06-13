import { vi } from 'vitest';
import type { AgentState } from '../../types.ts';
import type {
  AttestationPayloadBuilder,
  AttestationRetryQueue,
  ConfirmedExecution,
  Erc8004Client,
  ExecutionAttestationRepository,
} from '../record.ts';
import type { AttestationPayload } from '../recordSchema.ts';

export const STATE: AgentState = {
  agentId: 'agent-1',
  userId: 'user-1',
  chain: 'mantle-mainnet',
  goal: 'idle yield',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};

export const TICK_ID = 'tick-1';
export const NOW = new Date('2026-06-13T11:00:00Z');

export const EXEC: ConfirmedExecution = {
  executionId: 'exec-1',
  proposalId: 'prop-1',
  userOpHash: `0x${'a'.repeat(64)}`,
  txHash: `0x${'b'.repeat(64)}`,
  blockNumber: 123n,
  gasUsedActual: 100_000n,
};

export const ATTEST_UID = `0x${'c'.repeat(64)}`;
export const ATTEST_TX = `0x${'d'.repeat(64)}`;

export const PAYLOAD: AttestationPayload = {
  providerSchema: 'concierge.aave.v3.borrow.v1',
  payload: { asset: '0xUSDC', amount: '100' },
};

export function makeBuilder(over?: Partial<AttestationPayload>): AttestationPayloadBuilder {
  return {
    build: vi.fn().mockResolvedValue({ ...PAYLOAD, ...over }),
  };
}

export function makeAttester(
  over: Partial<{ attestationUid: string; attestationTxHash: string }> = {},
): Erc8004Client {
  return {
    attestAction: vi.fn().mockResolvedValue({
      attestationUid: ATTEST_UID,
      attestationTxHash: ATTEST_TX,
      ...over,
    }),
  };
}

export function makeRepo(
  initial: { readonly attestationUid: string | null } = { attestationUid: null },
): ExecutionAttestationRepository & {
  attached: Array<{ uid: string; txHash: string }>;
} {
  const attached: Array<{ uid: string; txHash: string }> = [];
  return {
    attached,
    getAttestation: vi.fn().mockResolvedValue(initial),
    attachAttestation: vi.fn().mockImplementation(async (a) => {
      attached.push({ uid: a.attestationUid, txHash: a.attestationTxHash });
    }),
  };
}

export function makeQueue(): AttestationRetryQueue {
  return { enqueue: vi.fn().mockResolvedValue({ jobId: 'retry-1' }) };
}
