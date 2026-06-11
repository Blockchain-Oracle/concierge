import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from '@concierge/shared';
import { parseAbi } from 'viem';
import type { ActionContext } from './_context.ts';

export const WOOFI_ABI = parseAbi([
  'function querySwap(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)',
  'function swap(address fromToken, address toToken, uint256 fromAmount, uint256 minToAmount, address to, address rebateTo) payable returns (uint256 realToAmount)',
]);

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const REBATE_TO = '0x0000000000000000000000000000000000000000' as Address;

export async function ensureApproval(
  ctx: ActionContext,
  token: Address,
  spender: Address,
  amount: bigint,
  account: Address,
  // biome-ignore lint/suspicious/noExplicitAny: viem WalletClient is generic
  walletClient: any,
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
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (receipt.status === 'reverted') {
    throw new ConciergeError('RpcError', `${tag}: approve tx ${approveHash} reverted`);
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
  // biome-ignore lint/suspicious/noExplicitAny: viem WalletClient is generic
  walletClient: any,
  tag: string,
): Promise<{ txHash: Hex; amountOut: bigint }> {
  const { result: amountOut, request } = await ctx.publicClient.simulateContract({
    address: ctx.addresses.woofiRouter,
    abi: WOOFI_ABI,
    functionName: 'swap',
    args: [tokenIn, tokenOut, amountIn, minOut, recipient, REBATE_TO],
    account,
  });

  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      ...request,
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

  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') {
    throw new ConciergeError('RpcError', `${tag}: swap tx ${txHash} reverted`);
  }
  return { txHash, amountOut };
}
