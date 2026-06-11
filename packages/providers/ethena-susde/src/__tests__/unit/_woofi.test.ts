import { ConciergeError } from '@concierge/sdk';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { ensureApproval, executeWooFiSwap, queryMinOut } from '../../_woofi.ts';

const WOO_SWAP_ABI = parseAbi([
  'event WooRouterSwap(uint8 swapType, address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address to, address rebateTo)',
]);

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const TOKEN = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' as const;
const SPENDER = '0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7' as const;
const ACCOUNT = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as const;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const AMOUNT = 1_000_000_000_000_000_000n;
const MIN_OUT = 990_000_000_000_000_000n;

function makeCtx(
  readContract: ReturnType<typeof vi.fn>,
  simulateContract?: ReturnType<typeof vi.fn>,
  waitForTransactionReceipt?: ReturnType<typeof vi.fn>,
): ActionContext {
  return {
    publicClient: {
      readContract,
      simulateContract: simulateContract ?? vi.fn(),
      waitForTransactionReceipt:
        waitForTransactionReceipt ?? vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    } as any,
    chainId: 5000,
    addresses: {
      usde: TOKEN,
      susde: TOKEN,
      usdc: ZERO,
      aavePool: ZERO,
      aaveOracle: ZERO,
      woofiRouter: SPENDER,
    },
  };
}

function makeWallet(writeContract: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(TX_HASH)) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  return { writeContract, chain: null, account: { address: ACCOUNT } } as any;
}

// --- queryMinOut ---

describe('queryMinOut', () => {
  it('returns minOut for a valid quote', async () => {
    const ctx = makeCtx(vi.fn().mockResolvedValue(AMOUNT));
    const minOut = await queryMinOut(ctx, TOKEN, TOKEN, AMOUNT, 50, 'test');
    // minOut = AMOUNT * (10000 - 50) / 10000
    expect(minOut).toBe((AMOUNT * 9950n) / 10_000n);
  });
});

// --- ensureApproval ---

describe('ensureApproval', () => {
  it('short-circuits when allowance already sufficient', async () => {
    const writeContract = vi.fn();
    const ctx = makeCtx(vi.fn().mockResolvedValue(AMOUNT)); // allowance = AMOUNT
    await ensureApproval(ctx, TOKEN, SPENDER, AMOUNT, ACCOUNT, makeWallet(writeContract), 'test');
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('calls writeContract when allowance is insufficient', async () => {
    const writeContract = vi.fn().mockResolvedValue(TX_HASH);
    const ctx = makeCtx(vi.fn().mockResolvedValue(0n)); // allowance = 0
    await ensureApproval(ctx, TOKEN, SPENDER, AMOUNT, ACCOUNT, makeWallet(writeContract), 'test');
    expect(writeContract).toHaveBeenCalledOnce();
  });

  it('throws ConciergeError(RpcError) when writeContract throws', async () => {
    const writeContract = vi.fn().mockRejectedValue(new Error('user rejected'));
    const ctx = makeCtx(vi.fn().mockResolvedValue(0n));
    await expect(
      ensureApproval(ctx, TOKEN, SPENDER, AMOUNT, ACCOUNT, makeWallet(writeContract), 'test'),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws ConciergeError(RpcError) when approve tx reverts', async () => {
    const ctx = makeCtx(
      vi.fn().mockResolvedValue(0n),
      undefined,
      vi.fn().mockResolvedValue({ status: 'reverted', logs: [] }),
    );
    await expect(
      ensureApproval(ctx, TOKEN, SPENDER, AMOUNT, ACCOUNT, makeWallet(), 'test'),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws ConciergeError(RpcError) when waitForTransactionReceipt times out', async () => {
    const ctx = makeCtx(
      vi.fn().mockResolvedValue(0n),
      undefined,
      vi.fn().mockRejectedValue(new Error('timeout')),
    );
    await expect(
      ensureApproval(ctx, TOKEN, SPENDER, AMOUNT, ACCOUNT, makeWallet(), 'test'),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});

// --- executeWooFiSwap ---

const MOCK_SIM = { result: MIN_OUT, request: {} };

describe('executeWooFiSwap — error paths', () => {
  it('throws ConciergeError(RpcError) when simulateContract fails', async () => {
    const simulate = vi.fn().mockRejectedValue(new Error('simulation reverted'));
    const ctx = makeCtx(vi.fn(), simulate);
    await expect(
      executeWooFiSwap(ctx, TOKEN, TOKEN, AMOUNT, MIN_OUT, ACCOUNT, ACCOUNT, makeWallet(), 'test'),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws ConciergeError(RpcError) when writeContract throws after successful simulation', async () => {
    const simulate = vi.fn().mockResolvedValue(MOCK_SIM);
    const writeContract = vi.fn().mockRejectedValue(new Error('gas spike'));
    const ctx = makeCtx(vi.fn(), simulate);
    await expect(
      executeWooFiSwap(
        ctx,
        TOKEN,
        TOKEN,
        AMOUNT,
        MIN_OUT,
        ACCOUNT,
        ACCOUNT,
        makeWallet(writeContract),
        'test',
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws ConciergeError(RpcError) when swap tx reverts on-chain', async () => {
    const simulate = vi.fn().mockResolvedValue(MOCK_SIM);
    const waitReceipt = vi.fn().mockResolvedValue({ status: 'reverted', logs: [] });
    const ctx = makeCtx(vi.fn(), simulate, waitReceipt);
    await expect(
      executeWooFiSwap(ctx, TOKEN, TOKEN, AMOUNT, MIN_OUT, ACCOUNT, ACCOUNT, makeWallet(), 'test'),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws ConciergeError(RpcError) when waitForTransactionReceipt times out', async () => {
    const simulate = vi.fn().mockResolvedValue(MOCK_SIM);
    const waitReceipt = vi
      .fn()
      .mockRejectedValue(new Error('WaitForTransactionReceiptTimeoutError'));
    const ctx = makeCtx(vi.fn(), simulate, waitReceipt);
    await expect(
      executeWooFiSwap(ctx, TOKEN, TOKEN, AMOUNT, MIN_OUT, ACCOUNT, ACCOUNT, makeWallet(), 'test'),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});

describe('executeWooFiSwap — success paths', () => {
  it('returns simulated amountOut when receipt has no matching WooRouterSwap event', async () => {
    const simulate = vi.fn().mockResolvedValue(MOCK_SIM);
    const waitReceipt = vi.fn().mockResolvedValue({ status: 'success', logs: [] });
    const ctx = makeCtx(vi.fn(), simulate, waitReceipt);
    const result = await executeWooFiSwap(
      ctx,
      TOKEN,
      TOKEN,
      AMOUNT,
      MIN_OUT,
      ACCOUNT,
      ACCOUNT,
      makeWallet(),
      'test',
    );
    expect(result.txHash).toBe(TX_HASH);
    expect(result.amountOut).toBe(MIN_OUT); // falls back to simulated
  });

  it('returns ground-truth amountOut from WooRouterSwap event when present in receipt', async () => {
    const ACTUAL_AMOUNT_OUT = AMOUNT + 500n; // intentionally different from MIN_OUT
    // Build a properly ABI-encoded WooRouterSwap log so parseEventLogs can decode it.
    const topics = encodeEventTopics({
      abi: WOO_SWAP_ABI,
      eventName: 'WooRouterSwap',
      args: { fromToken: TOKEN, toToken: TOKEN },
    });
    const data = encodeAbiParameters(
      [
        { name: 'swapType', type: 'uint8' },
        { name: 'fromAmount', type: 'uint256' },
        { name: 'toAmount', type: 'uint256' },
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'rebateTo', type: 'address' },
      ],
      [1, AMOUNT, ACTUAL_AMOUNT_OUT, ACCOUNT, ACCOUNT, ZERO],
    );
    const log = {
      address: SPENDER,
      topics,
      data,
      blockHash: `0x${'00'.repeat(32)}` as `0x${string}`,
      blockNumber: 1n,
      transactionHash: TX_HASH,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    };
    const simulate = vi.fn().mockResolvedValue(MOCK_SIM);
    const waitReceipt = vi.fn().mockResolvedValue({ status: 'success', logs: [log] });
    const ctx = makeCtx(vi.fn(), simulate, waitReceipt);
    const result = await executeWooFiSwap(
      ctx,
      TOKEN,
      TOKEN,
      AMOUNT,
      MIN_OUT,
      ACCOUNT,
      ACCOUNT,
      makeWallet(),
      'test',
    );
    expect(result.txHash).toBe(TX_HASH);
    expect(result.amountOut).toBe(ACTUAL_AMOUNT_OUT); // ground truth from event, not MIN_OUT
  });
});
