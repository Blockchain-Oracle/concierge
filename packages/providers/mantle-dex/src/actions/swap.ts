import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from '@concierge/shared';
import { tool } from '@concierge/tools';
import { parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_ZERO_ADDRESS, VENUE_NAME } from '../_schema.ts';
import type { VenueName, VenueQuoteResult } from '../_types.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { buildVenues } from './quote.ts';

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const SwapInput = z.object({
  tokenIn: NON_ZERO_ADDRESS.describe('ERC-20 token to sell'),
  tokenOut: NON_ZERO_ADDRESS.describe('ERC-20 token to receive'),
  amountIn: z.coerce.bigint().positive().describe('Amount of tokenIn in base units'),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(50)
    .describe('Max slippage in bps (default 50 = 0.5%)'),
  recipient: NON_ZERO_ADDRESS.describe('Address receiving the output tokens'),
});

export const SwapOutput = z.object({
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('Transaction hash of the swap'),
  venue: VENUE_NAME.describe('DEX venue used for execution'),
  amountIn: z.string().regex(/^\d+$/),
  amountOut: z.string().regex(/^\d+$/),
  attestationPayload: AttestationPayloadSchema,
});

async function ensureApproval(
  ctx: ActionContext,
  token: Address,
  spender: Address,
  amount: bigint,
  account: Address,
  // biome-ignore lint/suspicious/noExplicitAny: viem WalletClient is generic
  walletClient: any,
): Promise<void> {
  const allowance = await ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, spender],
  });
  if (allowance >= amount) return;
  let approveHash: Hex;
  try {
    approveHash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
      account,
      chain: walletClient.chain ?? null,
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      `[@concierge/mantle-dex] swap: ERC-20 approve failed for token ${token}`,
      err instanceof Error ? err : undefined,
    );
  }
  let receipt: Awaited<ReturnType<typeof ctx.publicClient.waitForTransactionReceipt>>;
  try {
    receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: approveHash });
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/mantle-dex] swap: timed out waiting for approve tx ${approveHash}`,
      err instanceof Error ? err : undefined,
    );
  }
  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/mantle-dex] swap: approve tx ${approveHash} reverted`,
    );
  }
}

export async function executeSwap(
  ctx: ActionContext,
  args: z.infer<typeof SwapInput>,
): Promise<z.infer<typeof SwapOutput>> {
  const { tokenIn, tokenOut, amountIn, slippageBps, recipient } = args;
  const { walletClient, account } = await requireWallet(ctx, 'swap');

  const venues = buildVenues(ctx);
  const settled = await Promise.allSettled(
    venues.map((v) => v.quote({ tokenIn, tokenOut, amountIn, account, slippageBps })),
  );

  const quotes: VenueQuoteResult[] = [];
  settled.forEach((s, i) => {
    const venueName = venues[i]?.name ?? `venue[${i}]`;
    if (s.status === 'rejected') {
      // Log but don't throw — one venue failure should not block others.
      console.error(`[@concierge/mantle-dex] swap: ${venueName} quote rejected:`, s.reason);
    } else if (s.value !== null) {
      quotes.push(s.value);
    }
  });

  if (quotes.length === 0) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      `[@concierge/mantle-dex] swap: no venue has a route for ${tokenIn} → ${tokenOut}`,
    );
  }

  const sorted = quotes.sort((a, b) =>
    a.amountOut === b.amountOut ? 0 : b.amountOut > a.amountOut ? 1 : -1,
  );
  const bestQuote = sorted[0];
  if (!bestQuote) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      '[@concierge/mantle-dex] swap: no quote results',
    );
  }
  const amountOutMin = (bestQuote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const winningVenue = venues.find((v) => v.name === bestQuote.venue);
  if (!winningVenue) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/mantle-dex] swap: internal error — venue not found',
    );
  }

  const spenderMap: Record<VenueName, Address> = {
    merchantMoe: ctx.addresses.merchantMoe.lbRouter,
    agni: ctx.addresses.agni.swapRouter,
    fusionx: ctx.addresses.fusionx.swapRouter,
    woofi: ctx.addresses.woofi.router,
    lifi: ctx.addresses.lifi.diamond,
  };
  // Li.Fi routes through executor-specific contracts; use the quoted approvalAddress when provided.
  const spender = bestQuote.approvalAddress ?? spenderMap[bestQuote.venue];

  await ensureApproval(ctx, tokenIn, spender, amountIn, account, walletClient);

  let swapResult: Awaited<ReturnType<typeof winningVenue.swap>>;
  try {
    swapResult = await winningVenue.swap({
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMin,
      slippageBps,
      recipient,
      account,
      deadline,
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      `[@concierge/mantle-dex] swap: ${bestQuote.venue} execution failed`,
      err instanceof Error ? err : undefined,
    );
  }

  if (swapResult.amountOut < amountOutMin) {
    throw new ConciergeError(
      'SwapSlippageBreach',
      `[@concierge/mantle-dex] swap: amountOut ${swapResult.amountOut} < amountOutMin ${amountOutMin}`,
      undefined,
      {
        expected: bestQuote.amountOut.toString(),
        actual: swapResult.amountOut.toString(),
        slippageBps,
      },
    );
  }

  let attestationPayload: ReturnType<typeof buildAttestationPayload>;
  try {
    attestationPayload = buildAttestationPayload({
      venue: bestQuote.venue,
      chainId: ctx.chainId,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: swapResult.amountOut,
      quotedOut: bestQuote.amountOut,
      slippageBps,
      txHash: swapResult.txHash,
    });
  } catch (err) {
    // Swap already committed — wrap Zod error so caller gets a typed ConciergeError with txHash.
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/mantle-dex] swap: attestation schema validation failed after swap ${swapResult.txHash}`,
      err instanceof Error ? err : undefined,
      { txHash: swapResult.txHash, venue: bestQuote.venue },
    );
  }

  return {
    txHash: swapResult.txHash,
    venue: bestQuote.venue,
    amountIn: amountIn.toString(),
    amountOut: swapResult.amountOut.toString(),
    attestationPayload,
  };
}

export function createSwapTool(ctx: ActionContext) {
  return tool({
    name: 'swap',
    description:
      'Execute a token swap via the best DEX on Mantle (Merchant Moe, Agni, FusionX, WOOFi, or Li.Fi). ' +
      'Re-quotes at execution time to protect against stale quotes. Handles ERC-20 approval automatically.',
    inputSchema: SwapInput,
    outputSchema: SwapOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeSwap(ctx, args),
  });
}
