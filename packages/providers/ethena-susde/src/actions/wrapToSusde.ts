import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_ZERO_ADDRESS, TX_HASH } from '../_schema.ts';
import { ensureApproval, executeWooFiSwap, WOOFI_ABI } from '../_woofi.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';

// Mantle sUSDe is a LayerZero V2 OFT — deposit()/redeem()/convertToAssets() all REVERT on Mantle.
// Wrap is implemented as a DEX swap USDe → sUSDe via WooFi (single-call, no cooldown).

export const WrapToSusdeInput = z.object({
  amountUSDe: z.coerce
    .bigint()
    .positive()
    .describe('Amount of USDe to swap in base units (18 decimals)'),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(50)
    .describe('Max slippage in bps (default 50 = 0.5%)'),
  recipient: NON_ZERO_ADDRESS.describe('Address receiving the sUSDe'),
});

export const WrapToSusdeOutput = z.object({
  txHash: TX_HASH,
  amountUsdeIn: z.string().regex(/^\d+$/),
  amountSusdeOut: z.string().regex(/^\d+$/),
  attestationPayload: AttestationPayloadSchema,
});

export async function executeWrapToSusde(
  ctx: ActionContext,
  args: z.infer<typeof WrapToSusdeInput>,
): Promise<z.infer<typeof WrapToSusdeOutput>> {
  const { amountUSDe, slippageBps, recipient } = args;
  const { walletClient, account } = await requireWallet(ctx, 'wrapToSusde');
  const { usde, susde, woofiRouter } = ctx.addresses;

  const quoted = await ctx.publicClient.readContract({
    address: woofiRouter,
    abi: WOOFI_ABI,
    functionName: 'querySwap',
    args: [usde, susde, amountUSDe],
  });
  if (quoted === 0n) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      '[@concierge/ethena-susde] wrapToSusde: WooFi has no USDe→sUSDe route',
    );
  }

  const minOut = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
  await ensureApproval(
    ctx,
    usde,
    woofiRouter,
    amountUSDe,
    account,
    walletClient,
    '[@concierge/ethena-susde] wrapToSusde',
  );

  const { txHash, amountOut: amountSusdeOut } = await executeWooFiSwap(
    ctx,
    usde,
    susde,
    amountUSDe,
    minOut,
    recipient as Address,
    account,
    walletClient,
    '[@concierge/ethena-susde] wrapToSusde',
  );

  const attestationPayload = buildAttestationPayload({
    action: 'wrap',
    chainId: ctx.chainId,
    tokenIn: usde,
    tokenOut: susde,
    amountIn: amountUSDe,
    amountOut: amountSusdeOut,
    txHash,
  });
  return {
    txHash,
    amountUsdeIn: amountUSDe.toString(),
    amountSusdeOut: amountSusdeOut.toString(),
    attestationPayload,
  };
}

export function createWrapToSusdeTool(ctx: ActionContext) {
  return tool({
    name: 'wrapToSusde',
    description:
      'Swaps USDe → sUSDe on Mantle via WooFi DEX. ' +
      'Mantle sUSDe is a LayerZero V2 OFT (not the L1 ERC-4626 vault) — there is no on-chain deposit(); ' +
      'sUSDe can only be acquired via DEX swap. Handles ERC-20 approval automatically.',
    inputSchema: WrapToSusdeInput,
    outputSchema: WrapToSusdeOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeWrapToSusde(ctx, args),
  });
}
