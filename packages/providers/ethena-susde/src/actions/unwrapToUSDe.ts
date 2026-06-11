import type { Address } from '@concierge/shared';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_ZERO_ADDRESS, TX_HASH } from '../_schema.ts';
import { ensureApproval, executeWooFiSwap, queryMinOut } from '../_woofi.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';

// NO cooldown on Mantle — the Mantle sUSDe is a LayerZero V2 OFT bridged image, NOT the
// L1 StakedUSDeV2 ERC-4626 vault. The 7-day cooldown exists only on Ethereum Mainnet.
// Unwrap is implemented as a DEX swap sUSDe → USDe via WooFi (instant, single call).

export const UnwrapToUSDEInput = z.object({
  amountSusde: z.coerce
    .bigint()
    .positive()
    .describe('Amount of sUSDe to swap in base units (18 decimals)'),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(50)
    .describe('Max slippage in bps (default 50 = 0.5%)'),
  recipient: NON_ZERO_ADDRESS.describe('Address receiving the USDe'),
});

export const UnwrapToUSDEOutput = z.object({
  txHash: TX_HASH,
  amountSusdeIn: z.string().regex(/^\d+$/),
  amountUsdeOut: z.string().regex(/^\d+$/),
  attestationPayload: AttestationPayloadSchema,
});

export async function executeUnwrapToUSDe(
  ctx: ActionContext,
  args: z.infer<typeof UnwrapToUSDEInput>,
): Promise<z.infer<typeof UnwrapToUSDEOutput>> {
  const { amountSusde, slippageBps, recipient } = args;
  const { walletClient, account } = await requireWallet(ctx, 'unwrapToUSDe');
  const { usde, susde, woofiRouter } = ctx.addresses;

  const minOut = await queryMinOut(
    ctx,
    susde,
    usde,
    amountSusde,
    slippageBps,
    '[@concierge/ethena-susde] unwrapToUSDe',
  );
  await ensureApproval(
    ctx,
    susde,
    woofiRouter,
    amountSusde,
    account,
    walletClient,
    '[@concierge/ethena-susde] unwrapToUSDe',
  );

  const { txHash, amountOut: amountUsdeOut } = await executeWooFiSwap(
    ctx,
    susde,
    usde,
    amountSusde,
    minOut,
    recipient as Address,
    account,
    walletClient,
    '[@concierge/ethena-susde] unwrapToUSDe',
  );

  const attestationPayload = buildAttestationPayload({
    action: 'unwrap',
    chainId: ctx.chainId,
    tokenIn: susde,
    tokenOut: usde,
    amountIn: amountSusde,
    amountOut: amountUsdeOut,
    txHash,
  });
  return {
    txHash,
    amountSusdeIn: amountSusde.toString(),
    amountUsdeOut: amountUsdeOut.toString(),
    attestationPayload,
  };
}

export function createUnwrapToUSDeTool(ctx: ActionContext) {
  return tool({
    name: 'unwrapToUSDe',
    description:
      'Swaps sUSDe → USDe on Mantle via WooFi DEX. ' +
      'NO cooldown — Mantle sUSDe is a LayerZero V2 OFT bridged image, not the L1 StakedUSDeV2 vault. ' +
      'The 7-day cooldown is L1-only; unwrap on Mantle is instant. Handles ERC-20 approval automatically.',
    inputSchema: UnwrapToUSDEInput,
    outputSchema: UnwrapToUSDEOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeUnwrapToUSDe(ctx, args),
  });
}
