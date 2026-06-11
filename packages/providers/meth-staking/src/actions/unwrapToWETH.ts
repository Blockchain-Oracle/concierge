import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import { computeRateFromSqrt, fetchPoolState } from '../_agni.ts';
import type { ActionContext } from '../_context.ts';
import { NON_NEG_INT_STR, NON_ZERO_ADDRESS } from '../_validators.ts';
import {
  METH_UNWRAP_SCHEMA,
  type UnwrapAttestationPayload,
  UnwrapAttestationPayloadSchema,
} from '../attestation.ts';

export const GetUnwrapToWETHInput = z.object({
  amountMeth: z.coerce
    .bigint()
    .positive()
    .describe('Amount of mETH to swap to WETH, in base units (18 decimals)'),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(50)
    .describe('Max slippage in bps (default 50 = 0.5%)'),
  recipient: NON_ZERO_ADDRESS.transform((v) => v as `0x${string}`).describe(
    'Address to receive WETH proceeds',
  ),
});

export const GetUnwrapToWETHOutput = z.object({
  dexTxHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('Transaction hash of the DEX swap that unwrapped mETH → WETH'),
  expectedEthOut: NON_NEG_INT_STR.describe(
    'WETH expected from oracle exchange rate × mETH amount (18 dec, bigint as string). ' +
      'Compare to actualEthOut to detect price manipulation between oracle and DEX execution.',
  ),
  actualEthOut: NON_NEG_INT_STR.describe(
    'Actual WETH received from the DEX swap (18 dec, bigint as string). ' +
      'Recorded in the attestation for manipulation detection.',
  ),
  attestationPayload: UnwrapAttestationPayloadSchema.describe('ERC-8004 attestation payload'),
});

export async function executeGetUnwrapToWETH(
  ctx: ActionContext,
  args: z.infer<typeof GetUnwrapToWETHInput>,
): Promise<z.infer<typeof GetUnwrapToWETHOutput>> {
  const { amountMeth, slippageBps, recipient } = args;

  // Compute oracle-based expected output BEFORE the swap for attestation anchoring.
  // Both pool read and rate computation are pre-swap — any failure here is safe to retry.
  let rate: bigint;
  try {
    const { sqrtPriceX96 } = await fetchPoolState(
      ctx.publicClient,
      ctx.addresses.agniMethWeth,
      'getUnwrapToWETH',
    );
    rate = computeRateFromSqrt(sqrtPriceX96);
  } catch (err) {
    if (err instanceof ConciergeError && err.type === 'OracleUnavailable') throw err;
    throw new ConciergeError(
      'OracleUnavailable',
      '[@concierge/meth-staking] getUnwrapToWETH: oracle price read or rate computation failed before swap — no funds moved, safe to retry',
      err instanceof Error ? err : undefined,
    );
  }
  const expectedEthOut = (amountMeth * rate) / 10n ** 18n;

  let swapResult: { txHash: string; amountOut: string };
  try {
    swapResult = await ctx.dexProvider.actions.swap.invoke({
      tokenIn: ctx.addresses.meth,
      tokenOut: ctx.addresses.weth,
      amountIn: amountMeth,
      slippageBps,
      recipient,
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      '[@concierge/meth-staking] getUnwrapToWETH: DEX swap failed',
      err instanceof Error ? err : undefined,
    );
  }

  const rawTxHash = swapResult.txHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawTxHash)) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/meth-staking] getUnwrapToWETH: DEX provider returned a malformed txHash: '${rawTxHash}' — swap may have executed; verify manually`,
    );
  }
  const dexTxHash = rawTxHash as `0x${string}`;
  const actualEthOut = swapResult.amountOut;

  // Swap executed — wrap any attestation failure with the txHash so it can be recorded manually.
  let attestationPayload: UnwrapAttestationPayload;
  try {
    attestationPayload = UnwrapAttestationPayloadSchema.parse({
      schema: METH_UNWRAP_SCHEMA,
      chain: ctx.chainId,
      dexTxHash,
      amountMethIn: amountMeth.toString(),
      expectedEthOut: expectedEthOut.toString(),
      actualEthOut,
      slippageBps,
      ts: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/meth-staking] getUnwrapToWETH: swap executed (txHash: ${dexTxHash}) but attestation payload validation failed — record the tx hash manually`,
      err instanceof Error ? err : undefined,
    );
  }

  return { dexTxHash, expectedEthOut: expectedEthOut.toString(), actualEthOut, attestationPayload };
}

export function createGetUnwrapToWETHTool(ctx: ActionContext) {
  return tool({
    name: 'getUnwrapToWETH',
    description:
      'Routes mETH → WETH via the best DEX on Mantle. This is NOT a native unstake — mETH on Mantle ' +
      'is a bridged ERC-20 with no L2 unstake function. The action is a DEX swap. Returns the tx hash ' +
      'and a `concierge.meth.unwrap-via-dex.v1` attestation so future auditors can verify the swap.',
    inputSchema: GetUnwrapToWETHInput,
    outputSchema: GetUnwrapToWETHOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeGetUnwrapToWETH(ctx, args),
  });
}
