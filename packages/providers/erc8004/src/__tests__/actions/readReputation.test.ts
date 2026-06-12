import { ConciergeError } from '@concierge/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeAttestAction } from '../../actions/attestAction.ts';
import { executeReadReputation } from '../../actions/readReputation.ts';
import { executeRegisterAgent } from '../../actions/registerAgent.ts';
import {
  type AnvilFork,
  IDENTITY_REGISTRY_SEPOLIA,
  REPUTATION_REGISTRY_SEPOLIA,
  startAnvilFork,
} from '../setup.ts';

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

  it('returns zero totals when clients exist but readAllFeedback returns empty arrays', async () => {
    const ctx = makeCtx((params: unknown) => {
      const p = params as { functionName: string };
      if (p.functionName === 'getClients') return [CLIENT];
      return [[], [], [], [], [], [], []];
    });
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

  it('uses highest feedbackIndex as latest even when entries arrive out of order', async () => {
    // Contract does not guarantee ascending order — highest index must win
    const outOfOrder = [
      [CLIENT, CLIENT, CLIENT],
      [2n, 0n, 1n],
      [1n, 1n, 1n],
      [0, 0, 0],
      ['concierge.action', 'concierge.action', 'concierge.action'],
      [
        'concierge.aave.v3.borrow.v1',
        'concierge.aave.v3.supply.v1',
        'concierge.lifi.bridge.sent.v1',
      ],
      [false, false, false],
    ];
    const ctx = makeReputationCtx(outOfOrder);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.latestAttestation?.feedbackIndex).toBe(2n);
    expect(result.latestAttestation?.schema).toBe('concierge.aave.v3.borrow.v1');
  });
});

describe('readReputation — revoked entries', () => {
  it('excludes revoked entries from totalAttestations and schemaCounts', async () => {
    const feedbackWithRevoked = [
      [CLIENT, CLIENT, CLIENT],
      [0n, 1n, 2n],
      [1n, 1n, 1n],
      [0, 0, 0],
      ['concierge.action', 'concierge.action', 'concierge.action'],
      ['concierge.aave.v3.borrow.v1', 'concierge.aave.v3.supply.v1', 'concierge.aave.v3.borrow.v1'],
      [true, false, false],
    ];
    const ctx = makeReputationCtx(feedbackWithRevoked);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.totalAttestations).toBe(2);
    expect(result.schemaCounts).toStrictEqual({
      'concierge.aave.v3.supply.v1': 1,
      'concierge.aave.v3.borrow.v1': 1,
    });
  });

  it('returns null latestAttestation when all entries are revoked', async () => {
    const allRevoked = [
      [CLIENT],
      [0n],
      [1n],
      [0],
      ['concierge.action'],
      ['concierge.aave.v3.borrow.v1'],
      [true],
    ];
    const ctx = makeReputationCtx(allRevoked);
    const result = await executeReadReputation(ctx, { agentId: AGENT_ID });
    expect(result.totalAttestations).toBe(0);
    expect(result.latestAttestation).toBeNull();
    expect(result.schemaCounts).toStrictEqual({});
  });
});

describe('readReputation — malformed contract responses', () => {
  it('throws RpcError when readAllFeedback array lengths are inconsistent', async () => {
    const inconsistent = [
      [CLIENT, CLIENT],
      [0n, 1n],
      [1n],
      [0, 0],
      ['concierge.action', 'concierge.action'],
      ['concierge.aave.v3.borrow.v1', 'concierge.lifi.bridge.sent.v1'],
      [false, false],
    ];
    const ctx = makeReputationCtx(inconsistent);
    await expect(executeReadReputation(ctx, { agentId: AGENT_ID })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('readReputation — fork: live Sepolia', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  });

  afterAll(async () => {
    await fork?.stop();
  });

  // ERC-8004: agent owner (account #0) registers; client (account #1) attests.
  function makeAgentCtx(): ActionContext {
    return {
      publicClient: fork.publicClient,
      // biome-ignore lint/suspicious/noExplicitAny: walletClient has correct chain binding; cast matches action expectations
      walletClient: fork.walletClient as any,
      identityRegistry: IDENTITY_REGISTRY_SEPOLIA,
      reputationRegistry: REPUTATION_REGISTRY_SEPOLIA,
      chainId: 5003,
    };
  }

  function makeClientCtx(): ActionContext {
    return {
      publicClient: fork.publicClient,
      // biome-ignore lint/suspicious/noExplicitAny: clientWalletClient has correct chain binding
      walletClient: fork.clientWalletClient as any,
      identityRegistry: IDENTITY_REGISTRY_SEPOLIA,
      reputationRegistry: REPUTATION_REGISTRY_SEPOLIA,
      chainId: 5003,
    };
  }

  it('freshly registered agent returns zero reputation', async () => {
    const { agentId } = await executeRegisterAgent(makeAgentCtx(), {});
    const result = await executeReadReputation(makeAgentCtx(), { agentId });
    expect(result.totalAttestations).toBe(0);
    expect(result.latestAttestation).toBeNull();
    expect(result.schemaCounts).toStrictEqual({});
  });

  it('schemaCounts reflects attests across multiple schemas', async () => {
    const { agentId } = await executeRegisterAgent(makeAgentCtx(), {});
    // 5 attests: borrow×2, supply×2, agni-swap×1 — matches BDD test_readReputation_AfterAttests
    const schemas = [
      'concierge.aave.v3.borrow.v1',
      'concierge.aave.v3.supply.v1',
      'concierge.aave.v3.borrow.v1',
      'concierge.aave.v3.supply.v1',
      'concierge.mantle-dex.agni.swap.v1',
    ] as const;
    for (const s of schemas) {
      await executeAttestAction(makeClientCtx(), {
        agentId,
        providerSchema: s,
        actionPayload: { schema: s, amount: '1' },
      });
    }
    const result = await executeReadReputation(makeAgentCtx(), { agentId });
    expect(result.totalAttestations).toBe(5);
    expect(result.schemaCounts['concierge.aave.v3.borrow.v1']).toBe(2);
    expect(result.schemaCounts['concierge.aave.v3.supply.v1']).toBe(2);
    expect(result.schemaCounts['concierge.mantle-dex.agni.swap.v1']).toBe(1);
    expect(result.latestAttestation).not.toBeNull();
    expect(result.latestAttestation?.feedbackIndex).toBeGreaterThanOrEqual(0n);
  });
});
