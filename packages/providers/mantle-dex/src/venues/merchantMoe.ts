import type { Address, Hex } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';
import { parseAbi } from 'viem';
import type {
  Venue,
  VenueQuoteParams,
  VenueQuoteResult,
  VenueSwapParams,
  VenueSwapResult,
} from '../_types.ts';

const lbQuoterAbi = parseAbi([
  'function findBestPathFromAmountIn(address[] calldata route, uint128 amountIn) external view returns ((address[] route, address[] pairs, uint256[] binSteps, uint8[] versions, uint128[] amounts, uint128[] virtualAmountsWithoutSlippage, uint256[] fees) quote)',
]);

const lbRouterAbi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (uint256[] pairBinSteps, uint8[] versions, address[] tokenPath) path, address to, uint256 deadline) external returns (uint256 amountOut)',
]);

export function createMerchantMoeVenue(
  publicClient: PublicClient,
  walletClient: WalletClient | undefined,
  lbRouter: Address,
  lbQuoter: Address,
): Venue {
  async function quote(params: VenueQuoteParams): Promise<VenueQuoteResult | null> {
    const { tokenIn, tokenOut, amountIn } = params;
    try {
      const result = await publicClient.readContract({
        address: lbQuoter,
        abi: lbQuoterAbi,
        functionName: 'findBestPathFromAmountIn',
        args: [[tokenIn, tokenOut], amountIn as unknown as bigint],
      });
      const amounts = result.amounts;
      if (!amounts || amounts.length < 2) return null;
      const amountOut = amounts[amounts.length - 1];
      if (amountOut === 0n) return null;
      return { venue: 'merchantMoe', amountOut };
    } catch {
      return null;
    }
  }

  async function swap(params: VenueSwapParams): Promise<VenueSwapResult> {
    if (!walletClient) {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'ConfigError',
        '[@concierge/mantle-dex] merchantMoe.swap: walletClient required',
      );
    }
    const { tokenIn, tokenOut, amountIn, amountOutMin, recipient, account, deadline } = params;

    // Re-quote to get fresh path data (binSteps, versions).
    const freshQuote = await publicClient.readContract({
      address: lbQuoter,
      abi: lbQuoterAbi,
      functionName: 'findBestPathFromAmountIn',
      args: [[tokenIn, tokenOut], amountIn as unknown as bigint],
    });

    const path = {
      pairBinSteps: freshQuote.binSteps,
      versions: freshQuote.versions,
      tokenPath: freshQuote.route as Address[],
    };

    const txHash = await walletClient.writeContract({
      address: lbRouter,
      abi: lbRouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, amountOutMin, path, recipient, deadline],
      account: account as Address,
      chain: walletClient.chain ?? null,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
      const { ConciergeError } = await import('@concierge/sdk');
      throw new ConciergeError(
        'RpcError',
        `[@concierge/mantle-dex] merchantMoe.swap: tx ${txHash} reverted`,
      );
    }

    const freshAmounts = freshQuote.amounts;
    const estimatedOut =
      freshAmounts.length >= 2 ? freshAmounts[freshAmounts.length - 1] : amountOutMin;
    return { txHash, amountOut: estimatedOut, spender: lbRouter };
  }

  return { name: 'merchantMoe', quote, swap };
}
