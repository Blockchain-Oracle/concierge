import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId, Hex } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';
import type {
  Venue,
  VenueQuoteParams,
  VenueQuoteResult,
  VenueSwapParams,
  VenueSwapResult,
} from '../_types.ts';

// Placeholder address used when quoting without a real sender — Li.Fi still returns valid amountOut.
const QUOTE_FROM = '0x0000000000000000000000000000000000000001' as Address;
const LIFI_API = 'https://li.quest/v1/quote';

interface LifiQuoteResponse {
  estimate?: {
    toAmountMin?: string;
    toAmount?: string;
    approvalAddress?: string;
  };
  transactionRequest?: {
    to?: string;
    data: string;
    value: string;
    gasLimit?: string;
  };
}

async function fetchLifiQuote(
  chainId: EvmChainId,
  fromToken: Address,
  toToken: Address,
  fromAmount: bigint,
  fromAddress: Address,
  slippageBps: number,
): Promise<LifiQuoteResponse | null> {
  const slippage = (slippageBps / 10_000).toFixed(6);
  const url = `${LIFI_API}?fromChain=${chainId}&toChain=${chainId}&fromToken=${fromToken}&toToken=${toToken}&fromAmount=${fromAmount.toString()}&fromAddress=${fromAddress}&slippage=${slippage}&order=CHEAPEST`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[@concierge/mantle-dex] lifi: HTTP ${res.status} from Li.Fi quote API`);
      return null;
    }
    return (await res.json()) as LifiQuoteResponse;
  } catch (err) {
    // Only swallow timeouts — DNS failures, JSON parse errors, etc. must propagate so
    // Promise.allSettled can log them rather than silently treating them as no-route.
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

export function createLifiVenue(
  chainId: EvmChainId,
  publicClient: PublicClient,
  walletClient: WalletClient | undefined,
  diamond: Address,
): Venue {
  async function quote(params: VenueQuoteParams): Promise<VenueQuoteResult | null> {
    const { tokenIn, tokenOut, amountIn } = params;
    const fromAddress = params.account ?? QUOTE_FROM;
    const slippageBps = params.slippageBps ?? 50;
    const data = await fetchLifiQuote(
      chainId,
      tokenIn,
      tokenOut,
      amountIn,
      fromAddress,
      slippageBps,
    );
    if (!data?.estimate?.toAmount) return null;
    const amountOut = BigInt(data.estimate.toAmount);
    if (amountOut === 0n) return null;
    if (data.estimate.approvalAddress) {
      return {
        venue: 'lifi',
        amountOut,
        approvalAddress: data.estimate.approvalAddress as Address,
      };
    }
    return { venue: 'lifi', amountOut };
  }

  async function swap(params: VenueSwapParams): Promise<VenueSwapResult> {
    if (!walletClient) {
      throw new ConciergeError(
        'ConfigError',
        '[@concierge/mantle-dex] lifi.swap: walletClient required',
      );
    }
    const { tokenIn, tokenOut, amountIn, account, slippageBps } = params;

    // Use the threaded slippageBps directly — avoids cross-token decimal math.
    const data = await fetchLifiQuote(chainId, tokenIn, tokenOut, amountIn, account, slippageBps);
    if (!data?.transactionRequest) {
      throw new ConciergeError(
        'InsufficientLiquidity',
        `[@concierge/mantle-dex] lifi.swap: no route from Li.Fi for ${tokenIn} → ${tokenOut}`,
      );
    }

    const req = data.transactionRequest;
    if (!req.to) {
      throw new ConciergeError(
        'RpcError',
        '[@concierge/mantle-dex] lifi.swap: Li.Fi response missing transactionRequest.to',
      );
    }

    const txHash = await walletClient.sendTransaction({
      to: req.to as Address,
      data: req.data as Hex,
      value: req.value ? BigInt(req.value) : 0n,
      account: account as Address,
      chain: walletClient.chain ?? null,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/mantle-dex] lifi.swap: tx ${txHash} reverted`,
      );
    }
    if (!data.estimate?.toAmount) {
      throw new ConciergeError(
        'RpcError',
        '[@concierge/mantle-dex] lifi.swap: Li.Fi response missing estimate.toAmount — cannot record attestation',
      );
    }
    const amountOut = BigInt(data.estimate.toAmount);
    return {
      txHash,
      amountOut,
      spender: (data.estimate?.approvalAddress as Address | undefined) ?? diamond,
    };
  }

  return { name: 'lifi', quote, swap };
}
