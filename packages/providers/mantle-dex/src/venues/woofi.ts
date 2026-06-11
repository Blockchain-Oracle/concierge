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

// WooRouterV2 — both quote and execution live here.
const routerAbi = parseAbi([
  'function querySwap(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)',
  'function swap(address fromToken, address toToken, uint256 fromAmount, uint256 minToAmount, address to, address rebateTo) payable returns (uint256 realToAmount)',
]);

export function createWooFiVenue(
  publicClient: PublicClient,
  walletClient: WalletClient | undefined,
  router: Address,
): Venue {
  async function quote(params: VenueQuoteParams): Promise<VenueQuoteResult | null> {
    const { tokenIn, tokenOut, amountIn } = params;
    try {
      const toAmount = await publicClient.readContract({
        address: router,
        abi: routerAbi,
        functionName: 'querySwap',
        args: [tokenIn, tokenOut, amountIn],
      });
      if (toAmount === 0n) return null;
      return { venue: 'woofi', amountOut: toAmount };
    } catch {
      // WooFi reverts when pair has no listing — return null to let aggregation continue.
      return null;
    }
  }

  async function swap(params: VenueSwapParams): Promise<VenueSwapResult> {
    if (!walletClient) {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'ConfigError',
        '[@concierge/mantle-dex] woofi.swap: walletClient required',
      );
    }
    const { tokenIn, tokenOut, amountIn, amountOutMin, recipient, account } = params;

    const txHash = await walletClient.writeContract({
      address: router,
      abi: routerAbi,
      functionName: 'swap',
      args: [
        tokenIn,
        tokenOut,
        amountIn,
        amountOutMin,
        recipient,
        '0x0000000000000000000000000000000000000000',
      ],
      account: account as Address,
      chain: walletClient.chain ?? null,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'RpcError',
        `[@concierge/mantle-dex] woofi.swap: tx ${txHash} reverted`,
      );
    }
    // WOOFi doesn't return amountOut in ABI; use amountOutMin as conservative floor.
    return { txHash, amountOut: amountOutMin, spender: router };
  }

  return { name: 'woofi', quote, swap };
}
