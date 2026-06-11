import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from '@concierge/shared';
import type { WalletClient } from 'viem';
import { ContractFunctionExecutionError, parseAbi, parseEventLogs } from 'viem';
import type { ActionContext } from './_context.ts';

export const WOOFI_ABI = parseAbi([
  'function querySwap(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)',
  'function swap(address fromToken, address toToken, uint256 fromAmount, uint256 minToAmount, address to, address rebateTo) payable returns (uint256 realToAmount)',
]);

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// WooRouterSwap event — parsed to get ground-truth amountOut from receipt.
const WOO_SWAP_EVENT_ABI = parseAbi([
  'event WooRouterSwap(uint8 swapType, address indexed fromToken, address indexed toToken, uint256 fromAmount, uint256 toAmount, address from, address to, address rebateTo)',
]);

const REBATE_TO = '0x0000000000000000000000000000000000000000' as Address;

export async function queryMinOut(
  ctx: ActionContext,
  fromToken: Address,
  toToken: Address,
  fromAmount: bigint,
  slippageBps: number,
  tag: string,
): Promise<bigint> {
  const quoted = await ctx.publicClient
    .readContract({
      address: ctx.addresses.woofiRouter,
      abi: WOOFI_ABI,
      functionName: 'querySwap',
      args: [fromToken, toToken, fromAmount],
    })
    .catch((err: unknown) => {
      if (err instanceof ConciergeError) throw err;
      // Only classify on-chain reverts as InsufficientLiquidity — network/timeout
      // errors are not liquidity failures and must propagate for proper retry logic.
      if (err instanceof ContractFunctionExecutionError) {
        throw new ConciergeError(
          'InsufficientLiquidity',
          `${tag}: WooFi querySwap reverted — token pair may not be supported`,
          err,
        );
      }
      throw err;
    });
  if (quoted === 0n) {
    throw new ConciergeError('InsufficientLiquidity', `${tag}: WooFi has no route`);
  }
  const minOut = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOut === 0n) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      `${tag}: minOut computed as 0 — input too small or slippage too high`,
    );
  }
  return minOut;
}

export async function ensureApproval(
  ctx: ActionContext,
  token: Address,
  spender: Address,
  amount: bigint,
  account: Address,
  walletClient: WalletClient,
  tag: string,
): Promise<void> {
  const allowance = await ctx.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account, spender],
  });
  if (allowance >= amount) return;

  let approveHash: Hex;
  try {
    approveHash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
      account,
      chain: walletClient.chain ?? null,
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      `${tag}: ERC-20 approve failed for ${token}`,
      err instanceof Error ? err : undefined,
    );
  }
  const receipt = await ctx.publicClient
    .waitForTransactionReceipt({ hash: approveHash })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `${tag}: timed out waiting for approve tx ${approveHash}`,
        err instanceof Error ? err : undefined,
      );
    });
  if (receipt.status === 'reverted') {
    throw new ConciergeError('RpcError', `${tag}: approve tx ${approveHash} reverted`);
  }
}

function parseSwapAmountOut(
  logs: Parameters<typeof parseEventLogs>[0]['logs'],
  simulatedAmountOut: bigint,
  tag: string,
): bigint {
  // Prefer ground-truth amountOut from the on-chain WooRouterSwap event over simulated estimate.
  try {
    const parsed = parseEventLogs({ abi: WOO_SWAP_EVENT_ABI, eventName: 'WooRouterSwap', logs });
    const toAmount = parsed[0]?.args.toAmount;
    if (toAmount === undefined) {
      // Tx landed but no matching event — router upgrade or unexpected ABI change.
      console.warn(`${tag}: WooRouterSwap event not found in receipt — using simulated amountOut`);
      return simulatedAmountOut;
    }
    return toAmount;
  } catch (err) {
    // Non-fatal: ABI decode failure on router upgrade falls back to simulated result.
    console.error(`${tag}: WooRouterSwap event parse failed — using simulated amountOut:`, err);
    return simulatedAmountOut;
  }
}

export async function executeWooFiSwap(
  ctx: ActionContext,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  minOut: bigint,
  recipient: Address,
  account: Address,
  walletClient: WalletClient,
  tag: string,
): Promise<{ txHash: Hex; amountOut: bigint }> {
  const sim = await ctx.publicClient
    .simulateContract({
      address: ctx.addresses.woofiRouter,
      abi: WOOFI_ABI,
      functionName: 'swap',
      args: [tokenIn, tokenOut, amountIn, minOut, recipient, REBATE_TO],
      account,
    })
    .catch((err: unknown) => {
      if (err instanceof ConciergeError) throw err;
      throw new ConciergeError(
        'RpcError',
        `${tag}: WooFi swap simulation failed`,
        err instanceof Error ? err : undefined,
      );
    });

  const simulatedAmountOut = sim.result;

  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      ...sim.request,
      chain: walletClient.chain ?? null,
      account,
    } as Parameters<typeof walletClient.writeContract>[0]);
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      `${tag}: WooFi swap tx failed`,
      err instanceof Error ? err : undefined,
    );
  }

  const receipt = await ctx.publicClient
    .waitForTransactionReceipt({ hash: txHash })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `${tag}: timed out waiting for swap tx ${txHash}`,
        err instanceof Error ? err : undefined,
      );
    });
  if (receipt.status === 'reverted') {
    throw new ConciergeError('RpcError', `${tag}: swap tx ${txHash} reverted`);
  }

  return { txHash, amountOut: parseSwapAmountOut(receipt.logs, simulatedAmountOut, tag) };
}
