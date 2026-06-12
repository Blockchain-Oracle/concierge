import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeReadReputation } from '../../actions/readReputation.ts';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const;
const CLIENT = '0x2222222222222222222222222222222222222222' as const;
const AGENT_ID = 7n;

// Shared tuple shapes for readAllFeedback mock responses
const THREE_ENTRIES_FEEDBACK = [
  [CLIENT, CLIENT, CLIENT],
  [0n, 1n, 2n],
  [1n, 1n, 1n],
  [0, 0, 0],
  ['concierge.action', 'concierge.action', 'concierge.action'],
  ['concierge.aave.v3.borrow.v1', 'concierge.aave.v3.supply.v1', 'concierge.aave.v3.borrow.v1'],
  [false, false, false],
];

const TWO_ENTRIES_FEEDBACK = [
  [CLIENT, CLIENT],
  [0n, 1n],
  [1n, 1n],
  [0, 0],
  ['concierge.action', 'concierge.action'],
  ['concierge.aave.v3.borrow.v1', 'concierge.lifi.bridge.sent.v1'],
  [false, false],
];

function makeCtx(readContractImpl: (...args: unknown[]) => unknown): ActionContext {
  return {
    walletClient: undefined,
    publicClient: {
      readContract: vi.fn().mockImplementation(readContractImpl),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock — PublicClient is a complex branded type
    } as any,
    identityRegistry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
    chainId: 5000,
  };
}

function makeReputationCtx(feedback: unknown[]) {
  return makeCtx((params: unknown) => {
    const p = params as { functionName: string };
    if (p.functionName === 'getClients') return [CLIENT];
    return feedback;
  });
}

describe('readReputation — fresh agent (no feedback)', () => {
  it('returns zero totals when getClients returns empty array', async () => {
    const ctx = makeCtx(() => []);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.totalAttestations).toBe(0);
    expect(result.latestAttestation).toBeNull();
    expect(result.schemaCounts).toStrictEqual({});
  });
});

describe('readReputation — totalAttestations and schemaCounts', () => {
  it('returns correct totalAttestations count', async () => {
    const ctx = makeReputationCtx(THREE_ENTRIES_FEEDBACK);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.totalAttestations).toBe(3);
  });

  it('schemaCounts reflects actual schemas used', async () => {
    const ctx = makeReputationCtx(THREE_ENTRIES_FEEDBACK);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.schemaCounts).toStrictEqual({
      'concierge.aave.v3.borrow.v1': 2,
      'concierge.aave.v3.supply.v1': 1,
    });
  });
});

describe('readReputation — latestAttestation', () => {
  it('latestAttestation matches the most recent feedback entry', async () => {
    const ctx = makeReputationCtx(TWO_ENTRIES_FEEDBACK);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.latestAttestation).not.toBeNull();
    expect(result.latestAttestation?.schema).toBe('concierge.lifi.bridge.sent.v1');
    expect(result.latestAttestation?.feedbackIndex).toBe(1n);
  });
});
