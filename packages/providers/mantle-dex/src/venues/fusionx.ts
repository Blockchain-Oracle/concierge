import type { Address } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';
import { parseAbi } from 'viem';
import type {
  Venue,
  VenueQuoteParams,
  VenueQuoteResult,
  VenueSwapParams,
  VenueSwapResult,
} from '../_types.ts';

// Algebra V3 QuoterV2 — individual params, no fee tier input.
const quoterAbi = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

// Algebra V3 SwapRouter — no fee in ExactInputSingleParams.
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice) params) payable returns (uint256 amountOut)',
]);

export function createFusionXVenue(
  publicClient: PublicClient,
  walletClient: WalletClient | undefined,
  swapRouter: Address,
  quoterV2: Address,
): Venue {
  async function quote(params: VenueQuoteParams): Promise<VenueQuoteResult | null> {
    const { tokenIn, tokenOut, amountIn } = params;
    try {
      const [amountOut] = await publicClient.readContract({
        address: quoterV2,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, amountIn, 0n],
      });
      if (amountOut === 0n) return null;
      return { venue: 'fusionx', amountOut };
    } catch {
      return null;
    }
  }

  async function swap(params: VenueSwapParams): Promise<VenueSwapResult> {
    if (!walletClient) {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'ConfigError',
        '[@concierge/mantle-dex] fusionx.swap: walletClient required',
      );
    }
    const { tokenIn, tokenOut, amountIn, amountOutMin, recipient, account, deadline } = params;

    // Re-quote for freshness.
    let freshAmountOut: bigint;
    try {
      const [ao] = await publicClient.readContract({
        address: quoterV2,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, amountIn, 0n],
      });
      if (ao === 0n) throw new Error('zero');
      freshAmountOut = ao;
    } catch {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'InsufficientLiquidity',
        `[@concierge/mantle-dex] fusionx.swap: no route for ${tokenIn} → ${tokenOut}`,
      );
    }

    const txHash = await walletClient.writeContract({
      address: swapRouter,
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          recipient,
          deadline,
          amountIn,
          amountOutMinimum: amountOutMin,
          limitSqrtPrice: 0n,
        },
      ],
      account: account as Address,
      chain: walletClient.chain ?? null,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'RpcError',
        `[@concierge/mantle-dex] fusionx.swap: tx ${txHash} reverted`,
      );
    }
    return { txHash, amountOut: freshAmountOut, spender: swapRouter };
  }

  return { name: 'fusionx', quote, swap };
}
