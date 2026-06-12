import { ConciergeError } from '@concierge/sdk';
import { identityRegistryAbi } from '@concierge/shared/abi';
import { encodeEventTopics, parseAbi, zeroAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeRegisterAgent } from '../../actions/registerAgent.ts';
import {
  type AnvilFork,
  IDENTITY_REGISTRY_SEPOLIA,
  REPUTATION_REGISTRY_SEPOLIA,
  startAnvilFork,
  TEST_ACCOUNT,
} from '../setup.ts';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const;
const OWNER = '0x1111111111111111111111111111111111111111' as const;
const TX_HASH = '0xaaaa000000000000000000000000000000000000000000000000000000000001' as const;
const AGENT_ID = 7n;

// Build a Transfer(from=0x0, to=owner, tokenId=AGENT_ID) log entry using viem ABI encoding
function makeTransferLog() {
  const topics = encodeEventTopics({
    abi: identityRegistryAbi,
    eventName: 'Transfer',
    args: { from: zeroAddress, to: OWNER, tokenId: AGENT_ID },
  });
  return {
    address: IDENTITY_REGISTRY,
    topics,
    data: '0x' as `0x${string}`,
    blockNumber: 1000n,
    transactionHash: TX_HASH,
    logIndex: 0,
    transactionIndex: 0,
    blockHash: '0xbbbb' as `0x${string}`,
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
      logs: [makeTransferLog()],
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

describe('registerAgent — happy path', () => {
  it('returns agentId from Transfer mint event', async () => {
    const ctx = makeCtx();
    const result = await executeRegisterAgent(ctx, {});
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.txHash).toBe(TX_HASH);
  });

  it('calls writeContract with register() and no args when agentURI absent', async () => {
    const ctx = makeCtx();
    await executeRegisterAgent(ctx, {});
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const call = (ctx.walletClient as any).writeContract.mock.calls[0][0];
    expect(call.functionName).toBe('register');
    expect(call.args).toStrictEqual([]);
  });

  it('calls writeContract with [agentURI] when agentURI is provided', async () => {
    const ctx = makeCtx();
    await executeRegisterAgent(ctx, { agentURI: 'ipfs://Qm123' });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock fn
    const call = (ctx.walletClient as any).writeContract.mock.calls[0][0];
    expect(call.args).toStrictEqual(['ipfs://Qm123']);
  });
});

describe('registerAgent — error paths', () => {
  it('throws ConfigError when walletClient is absent', async () => {
    const ctx: ActionContext = {
      walletClient: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock for error path
      publicClient: {} as any,
      identityRegistry: IDENTITY_REGISTRY,
      reputationRegistry: REPUTATION_REGISTRY,
      chainId: 5000,
    };
    await expect(executeRegisterAgent(ctx, {})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('throws RpcError when writeContract rejects', async () => {
    const ctx = makeCtx({
      writeContract: vi.fn().mockRejectedValue(new Error('execution reverted')),
    });
    await expect(executeRegisterAgent(ctx, {})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when waitForTransactionReceipt rejects', async () => {
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error('network timeout')),
    });
    await expect(executeRegisterAgent(ctx, {})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when transaction is reverted', async () => {
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', logs: [] }),
    });
    await expect(executeRegisterAgent(ctx, {})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when receipt has no Transfer mint event', async () => {
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
    });
    await expect(executeRegisterAgent(ctx, {})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('registerAgent — log parsing', () => {
  it('skips non-mint Transfer events and extracts agentId only from the mint', async () => {
    const OTHER = '0x3333333333333333333333333333333333333333' as const;
    const nonMintTopics = encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: 'Transfer',
      args: { from: OWNER, to: OTHER, tokenId: 999n },
    });
    const nonMintLog = { ...makeTransferLog(), topics: nonMintTopics, logIndex: 0 };
    const mintLog = { ...makeTransferLog(), logIndex: 1 };
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [nonMintLog, mintLog],
      }),
    });
    const result = await executeRegisterAgent(ctx, {});
    expect(result.agentId).toBe(AGENT_ID);
  });

  it('skips Transfer logs from contracts other than identityRegistry', async () => {
    const OTHER_CONTRACT = '0x4444444444444444444444444444444444444444' as const;
    const foreignLog = { ...makeTransferLog(), address: OTHER_CONTRACT };
    const ctx = makeCtx(undefined, {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [foreignLog, makeTransferLog()],
      }),
    });
    const result = await executeRegisterAgent(ctx, {});
    expect(result.agentId).toBe(AGENT_ID);
  });
});

describe('registerAgent — fork: live Sepolia IdentityRegistry', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  });

  afterAll(async () => {
    await fork.stop();
  });

  function makeForkedCtx(): ActionContext {
    return {
      publicClient: fork.publicClient,
      // biome-ignore lint/suspicious/noExplicitAny: walletClient has correct chain binding; cast matches action expectations
      walletClient: fork.walletClient as any,
      identityRegistry: IDENTITY_REGISTRY_SEPOLIA,
      reputationRegistry: REPUTATION_REGISTRY_SEPOLIA,
      chainId: 5003,
    };
  }

  it('registers a fresh agent and returns agentId > 0', async () => {
    const ctx = makeForkedCtx();
    const result = await executeRegisterAgent(ctx, {});
    expect(result.agentId).toBeGreaterThan(0n);
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('ownerOf(agentId) returns the test account after register', async () => {
    const ctx = makeForkedCtx();
    const { agentId } = await executeRegisterAgent(ctx, {});
    const ownerOfAbi = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)']);
    const owner = await fork.publicClient.readContract({
      address: IDENTITY_REGISTRY_SEPOLIA,
      abi: ownerOfAbi,
      functionName: 'ownerOf',
      args: [agentId],
    });
    expect(owner.toLowerCase()).toBe(TEST_ACCOUNT.toLowerCase());
  });

  it('two sequential registers produce monotonically increasing agentIds', async () => {
    const ctx = makeForkedCtx();
    const { agentId: id1 } = await executeRegisterAgent(ctx, {});
    const { agentId: id2 } = await executeRegisterAgent(ctx, {});
    expect(id2).toBe(id1 + 1n);
  });
});
