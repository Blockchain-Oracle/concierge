import { ConciergeError } from '@concierge/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeAttestAction } from '../../actions/attestAction.ts';
import { executeReadFeedback } from '../../actions/readFeedback.ts';
import { executeRegisterAgent } from '../../actions/registerAgent.ts';
import { hashActionPayload } from '../../eip712.ts';
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

const FEEDBACK_HASH_1 =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
const FEEDBACK_HASH_2 =
  '0xbbbb000000000000000000000000000000000000000000000000000000000002' as `0x${string}`;
const TX_1 = '0xcccc000000000000000000000000000000000000000000000000000000000003' as `0x${string}`;
const TX_2 = '0xdddd000000000000000000000000000000000000000000000000000000000004' as `0x${string}`;

function makeFakeLogs() {
  return [
    {
      args: {
        agentId: AGENT_ID,
        clientAddress: CLIENT,
        feedbackIndex: 0n,
        value: 1n,
        valueDecimals: 0,
        tag1: 'concierge.action',
        tag2: 'concierge.aave.v3.borrow.v1',
        endpoint: '',
        feedbackURI: '',
        feedbackHash: FEEDBACK_HASH_1,
      },
      blockNumber: 1000n,
      transactionHash: TX_1,
    },
    {
      args: {
        agentId: AGENT_ID,
        clientAddress: CLIENT,
        feedbackIndex: 1n,
        value: 1n,
        valueDecimals: 0,
        tag1: 'concierge.action',
        tag2: 'concierge.lifi.bridge.sent.v1',
        endpoint: '',
        feedbackURI: '',
        feedbackHash: FEEDBACK_HASH_2,
      },
      blockNumber: 2000n,
      transactionHash: TX_2,
    },
  ];
}

// Discriminates by eventName: NewFeedback returns the provided logs, FeedbackRevoked returns []
function makeCtx(logs: unknown[], revokedLogs: unknown[] = []): ActionContext {
  return {
    walletClient: undefined,
    publicClient: {
      getContractEvents: vi.fn().mockImplementation((params: unknown) => {
        const p = params as { eventName: string };
        return Promise.resolve(p.eventName === 'NewFeedback' ? logs : revokedLogs);
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock — PublicClient is a complex branded type
    } as any,
    identityRegistry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
    chainId: 5000,
  };
}

describe('readFeedback — log field mapping', () => {
  it('returns all feedback entries from event logs', async () => {
    const ctx = makeCtx(makeFakeLogs());
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries).toHaveLength(2);
  });

  it('maps tag2 to schema field', async () => {
    const ctx = makeCtx(makeFakeLogs());
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries[0]?.schema).toBe('concierge.aave.v3.borrow.v1');
    expect(result.entries[1]?.schema).toBe('concierge.lifi.bridge.sent.v1');
  });

  it('maps feedbackHash from event log', async () => {
    const ctx = makeCtx(makeFakeLogs());
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries[0]?.feedbackHash).toBe(FEEDBACK_HASH_1);
    expect(result.entries[1]?.feedbackHash).toBe(FEEDBACK_HASH_2);
  });

  it('returns empty entries for agent with no feedback', async () => {
    const ctx = makeCtx([]);
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries).toStrictEqual([]);
  });
});

describe('readFeedback — edge cases', () => {
  it('skips pending logs where blockNumber or transactionHash is null', async () => {
    const logsWithPending = [
      ...makeFakeLogs(),
      {
        args: {
          agentId: AGENT_ID,
          clientAddress: CLIENT,
          feedbackIndex: 2n,
          tag2: 'test',
          feedbackHash: FEEDBACK_HASH_1,
        },
        blockNumber: null,
        transactionHash: null,
      },
    ];
    const ctx = makeCtx(logsWithPending);
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries).toHaveLength(2);
  });

  it('throws RpcError when getContractEvents rejects for NewFeedback', async () => {
    const ctx: ActionContext = {
      walletClient: undefined,
      publicClient: {
        getContractEvents: vi.fn().mockRejectedValue(new Error('rpc timeout')),
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock for error path
      } as any,
      identityRegistry: IDENTITY_REGISTRY,
      reputationRegistry: REPUTATION_REGISTRY,
      chainId: 5000,
    };
    await expect(executeReadFeedback(ctx, { agentId: AGENT_ID })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('readFeedback — call parameters', () => {
  it('calls getContractEvents with fromBlock = 0n when not specified', async () => {
    const ctx = makeCtx([]);
    await executeReadFeedback(ctx, { agentId: AGENT_ID });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const call = (ctx.publicClient as any).getContractEvents.mock.calls[0][0];
    expect(call.fromBlock).toBe(0n);
  });

  it('passes fromBlock when specified', async () => {
    const ctx = makeCtx([]);
    await executeReadFeedback(ctx, { agentId: AGENT_ID, fromBlock: 5000n });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const call = (ctx.publicClient as any).getContractEvents.mock.calls[0][0];
    expect(call.fromBlock).toBe(5000n);
  });

  it('filters events by agentId and targets the reputation registry address', async () => {
    const ctx = makeCtx([]);
    await executeReadFeedback(ctx, { agentId: AGENT_ID });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const call = (ctx.publicClient as any).getContractEvents.mock.calls[0][0];
    expect(call.args.agentId).toBe(AGENT_ID);
    expect(call.address).toBe(REPUTATION_REGISTRY);
  });

  it('passes fromBlock to the FeedbackRevoked call', async () => {
    const ctx = makeCtx([]);
    await executeReadFeedback(ctx, { agentId: AGENT_ID, fromBlock: 5000n });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const revokedCall = (ctx.publicClient as any).getContractEvents.mock.calls[1][0];
    expect(revokedCall.eventName).toBe('FeedbackRevoked');
    expect(revokedCall.fromBlock).toBe(5000n);
  });

  it('calls FeedbackRevoked on the reputation registry with the correct agentId', async () => {
    const ctx = makeCtx([]);
    await executeReadFeedback(ctx, { agentId: AGENT_ID });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const revokedCall = (ctx.publicClient as any).getContractEvents.mock.calls[1][0];
    expect(revokedCall.address).toBe(REPUTATION_REGISTRY);
    expect(revokedCall.args.agentId).toBe(AGENT_ID);
  });
});

describe('readFeedback — revoked entries', () => {
  it('marks entries present in FeedbackRevoked as revoked=true', async () => {
    const revokedLogs = [{ args: { feedbackIndex: 0n } }];
    const ctx = makeCtx(makeFakeLogs(), revokedLogs);
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries[0]?.revoked).toBe(true);
    expect(result.entries[1]?.revoked).toBe(false);
  });

  it('marks all entries non-revoked when FeedbackRevoked returns empty', async () => {
    const ctx = makeCtx(makeFakeLogs());
    const result = await executeReadFeedback(ctx, { agentId: AGENT_ID });
    expect(result.entries.every((e) => e.revoked === false)).toBe(true);
  });

  it('throws RpcError when FeedbackRevoked fetch fails', async () => {
    const ctx: ActionContext = {
      walletClient: undefined,
      publicClient: {
        getContractEvents: vi.fn().mockImplementation((params: unknown) => {
          const p = params as { eventName: string };
          if (p.eventName === 'NewFeedback') return Promise.resolve(makeFakeLogs());
          return Promise.reject(new Error('rpc timeout'));
        }),
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock for error path
      } as any,
      identityRegistry: IDENTITY_REGISTRY,
      reputationRegistry: REPUTATION_REGISTRY,
      chainId: 5000,
    };
    await expect(executeReadFeedback(ctx, { agentId: AGENT_ID })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('readFeedback — fork: live Sepolia', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  });

  afterAll(async () => {
    await fork.stop();
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

  it('iterates 3 NewFeedback events; each entry schema and feedbackHash match the attest payload', async () => {
    const { agentId } = await executeRegisterAgent(makeAgentCtx(), {});
    const schemas = [
      'concierge.aave.v3.borrow.v1',
      'concierge.aave.v3.supply.v1',
      'concierge.mantle-dex.agni.swap.v1',
    ] as const;
    const payloads = schemas.map((s) => ({ schema: s, amount: '500' }));
    const expectedHashes = payloads.map((p) => hashActionPayload(p, agentId, 5003));

    for (const [i, s] of schemas.entries()) {
      await executeAttestAction(makeClientCtx(), {
        agentId,
        providerSchema: s,
        actionPayload: payloads[i] ?? { schema: s, amount: '500' },
      });
    }

    const { entries } = await executeReadFeedback(makeAgentCtx(), {
      agentId,
      fromBlock: fork.forkBlockNumber,
    });
    expect(entries).toHaveLength(3);
    for (const [i, entry] of entries.entries()) {
      expect(entry.schema).toBe(schemas[i]);
      expect(entry.feedbackHash).toBe(expectedHashes[i]);
      expect(entry.revoked).toBe(false);
    }
  });
});
