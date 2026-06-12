import { ConciergeError } from '@concierge/sdk';
import { reputationRegistryAbi } from '@concierge/shared/abi';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeAttestAction } from '../../actions/attestAction.ts';
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
const OWNER = '0x1111111111111111111111111111111111111111' as const;
const TX_HASH = '0xbbbb000000000000000000000000000000000000000000000000000000000002' as const;
const AGENT_ID = 7n;
const FEEDBACK_INDEX = 0n;
const SCHEMA = 'concierge.aave.v3.borrow.v1';

const ACTION_PAYLOAD = {
  schema: SCHEMA,
  preHF: '1.5',
  postHF: '1.4',
  amount: '1000000000',
};

// Build a minimal NewFeedback log entry for the given feedbackIndex
function makeNewFeedbackLog(feedbackIndex: bigint) {
  // NewFeedback(agentId indexed, clientAddress indexed, feedbackIndex, value, valueDecimals, indexedTag1 indexed, tag1, tag2, endpoint, feedbackURI, feedbackHash)
  const feedbackHash = hashActionPayload(ACTION_PAYLOAD, AGENT_ID, 5000);

  const topics = encodeEventTopics({
    abi: reputationRegistryAbi,
    eventName: 'NewFeedback',
    // indexedTag1 is an indexed string — must be provided so topics array has 4 entries
    // (eventSig, agentId, clientAddress, keccak256(tag1))
    args: { agentId: AGENT_ID, clientAddress: OWNER, indexedTag1: 'concierge.action' },
  });

  // Encode non-indexed fields as ABI data
  const data = encodeAbiParameters(
    parseAbiParameters('uint64, int128, uint8, string, string, string, string, bytes32'),
    [feedbackIndex, 1n, 0, 'concierge.action', SCHEMA, '', '', feedbackHash],
  );

  return {
    address: REPUTATION_REGISTRY,
    topics,
    data,
    blockNumber: 2000n,
    transactionHash: TX_HASH,
    logIndex: 0,
    transactionIndex: 0,
    blockHash: '0xcccc' as `0x${string}`,
    removed: false,
  };
}

function makeCtx(walletOverride?: object, publicOverride?: object): ActionContext {
  const walletClient = {
    account: { address: OWNER },
    chain: { id: 5000 },
    writeContract: vi.fn().mockResolvedValue(TX_HASH),
    ...walletOverride,
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock — WalletClient is a complex branded type
  } as any;

  const publicClient = {
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success',
      logs: [makeNewFeedbackLog(FEEDBACK_INDEX)],
    }),
    ...publicOverride,
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock — PublicClient is a complex branded type
  } as any;

  return {
    walletClient,
    publicClient,
    identityRegistry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
    chainId: 5000,
  };
}

describe('attestAction — happy path', () => {
  it('returns txHash, feedbackIndex, and feedbackHash', async () => {
    const ctx = makeCtx();
    const result = await executeAttestAction(ctx, {
      agentId: AGENT_ID,
      providerSchema: SCHEMA,
      actionPayload: ACTION_PAYLOAD,
    });
    expect(result.txHash).toBe(TX_HASH);
    expect(result.feedbackIndex).toBe(FEEDBACK_INDEX);
    expect(result.feedbackHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('returns correct feedbackIndex for non-zero index values', async () => {
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [makeNewFeedbackLog(99n)],
      }),
    });
    const result = await executeAttestAction(ctx, {
      agentId: AGENT_ID,
      providerSchema: SCHEMA,
      actionPayload: ACTION_PAYLOAD,
    });
    expect(result.feedbackIndex).toBe(99n);
  });

  it('feedbackHash matches hashActionPayload(payload, agentId, chainId)', async () => {
    const ctx = makeCtx();
    const result = await executeAttestAction(ctx, {
      agentId: AGENT_ID,
      providerSchema: SCHEMA,
      actionPayload: ACTION_PAYLOAD,
    });
    const expected = hashActionPayload(ACTION_PAYLOAD, AGENT_ID, 5000);
    expect(result.feedbackHash).toBe(expected);
  });

  it('calls giveFeedback with correct tag1 (concierge.action) and tag2 (providerSchema)', async () => {
    const ctx = makeCtx();
    await executeAttestAction(ctx, {
      agentId: AGENT_ID,
      providerSchema: SCHEMA,
      actionPayload: ACTION_PAYLOAD,
    });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const call = (ctx.walletClient as any).writeContract.mock.calls[0][0];
    expect(call.functionName).toBe('giveFeedback');
    const [, , , tag1, tag2] = call.args as [bigint, bigint, number, string, string];
    expect(tag1).toBe('concierge.action');
    expect(tag2).toBe(SCHEMA);
  });
});

describe('attestAction — input validation errors', () => {
  it('throws ConfigError when walletClient is absent', async () => {
    const ctx: ActionContext = {
      walletClient: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock for error path
      publicClient: {} as any,
      identityRegistry: IDENTITY_REGISTRY,
      reputationRegistry: REPUTATION_REGISTRY,
      chainId: 5000,
    };
    await expect(
      executeAttestAction(ctx, {
        agentId: AGENT_ID,
        providerSchema: SCHEMA,
        actionPayload: ACTION_PAYLOAD,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('throws ConfigError when actionPayload.schema does not match providerSchema', async () => {
    const ctx = makeCtx();
    await expect(
      executeAttestAction(ctx, {
        agentId: AGENT_ID,
        providerSchema: SCHEMA,
        actionPayload: { ...ACTION_PAYLOAD, schema: 'concierge.aave.v3.supply.v1' },
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });
});

describe('attestAction — transaction errors', () => {
  it('throws AttestationFailed when writeContract rejects', async () => {
    const ctx = makeCtx({
      writeContract: vi.fn().mockRejectedValue(new Error('AgentNotFound(99999)')),
    });
    await expect(
      executeAttestAction(ctx, {
        agentId: 99999n,
        providerSchema: SCHEMA,
        actionPayload: ACTION_PAYLOAD,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'AttestationFailed',
    );
  });

  it('throws RpcError when receipt has no NewFeedback event', async () => {
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
    });
    await expect(
      executeAttestAction(ctx, {
        agentId: AGENT_ID,
        providerSchema: SCHEMA,
        actionPayload: ACTION_PAYLOAD,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws AttestationFailed when transaction is reverted', async () => {
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', logs: [] }),
    });
    await expect(
      executeAttestAction(ctx, {
        agentId: AGENT_ID,
        providerSchema: SCHEMA,
        actionPayload: ACTION_PAYLOAD,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'AttestationFailed',
    );
  });
});

describe('attestAction — fork: live Sepolia ReputationRegistry', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  });

  afterAll(async () => {
    await fork.stop();
  });

  // ERC-8004 enforces "Self-feedback not allowed": the agent owner cannot attest on itself.
  // agentCtx (account #0) registers; clientCtx (account #1) submits giveFeedback.
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

  it('register → attest succeeds; feedbackHash matches local EIP-712 computation', async () => {
    const { agentId } = await executeRegisterAgent(makeAgentCtx(), {});
    const payload = { schema: 'concierge.aave.v3.borrow.v1', amount: '1000000' };
    const result = await executeAttestAction(makeClientCtx(), {
      agentId,
      providerSchema: 'concierge.aave.v3.borrow.v1',
      actionPayload: payload,
    });
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.feedbackIndex).toBeGreaterThanOrEqual(0n);
    expect(result.feedbackHash).toBe(hashActionPayload(payload, agentId, 5003));
  });

  it('attest against non-existent agentId throws AttestationFailed with reason AgentNotFound', async () => {
    await expect(
      executeAttestAction(makeClientCtx(), {
        agentId: 99999n,
        providerSchema: 'concierge.aave.v3.borrow.v1',
        actionPayload: { schema: 'concierge.aave.v3.borrow.v1', amount: '1' },
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'AttestationFailed' &&
        (e.metadata as { reason?: string } | undefined)?.reason === 'AgentNotFound',
    );
  });
});
