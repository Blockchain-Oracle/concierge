import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { type PublicClient, parseAbi } from 'viem';
import { z } from 'zod';
import { computePriceFromSqrt, fetchPoolState } from '../_agni.ts';
import type { ActionContext } from '../_context.ts';
import { NON_NEG_INT_STR } from '../_validators.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';

const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

export const GetBalanceInput = z.object({
  user: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe('User wallet address'),
});

export const GetBalanceOutput = z.object({
  raw: NON_NEG_INT_STR.describe('Raw USDY balance (18 dec, bigint as string)'),
  usdValue: NON_NEG_INT_STR.describe(
    'USD value of balance at DEX spot price (18 dec, bigint as string)',
  ),
  yieldAccrued: NON_NEG_INT_STR.describe(
    'Appreciation above $1.00 face value (18 dec, bigint as string)',
  ),
  attestationPayload: AttestationPayloadSchema.describe('ERC-8004 attestation payload'),
});

async function readBalance(
  publicClient: PublicClient,
  token: `0x${string}`,
  user: `0x${string}`,
): Promise<bigint> {
  return publicClient
    .readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/ondo-usdy] getBalance: failed to read USDY balance for ${user}`,
        err instanceof Error ? err : undefined,
      );
    });
}

export async function executeGetBalance(
  ctx: ActionContext,
  user: `0x${string}`,
): Promise<z.infer<typeof GetBalanceOutput>> {
  const [raw, poolState, blockNumber] = await Promise.all([
    readBalance(ctx.publicClient, ctx.addresses.usdy, user),
    fetchPoolState(ctx.publicClient, ctx.addresses.agniUsdyUsdc, 'getBalance'),
    ctx.publicClient.getBlockNumber().catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        '[@concierge/ondo-usdy] getBalance: failed to fetch block number for attestation',
        err instanceof Error ? err : undefined,
      );
    }),
  ]);

  const multiplier = computePriceFromSqrt(poolState.sqrtPriceX96);
  const usdValue = (raw * multiplier) / 10n ** 18n;
  const yieldAccrued = usdValue > raw ? usdValue - raw : 0n;

  const attestationPayload = buildAttestationPayload({
    chainId: ctx.chainId,
    user,
    balance: raw,
    multiplier,
    blockNumber: Number(blockNumber),
  });

  return {
    raw: raw.toString(),
    usdValue: usdValue.toString(),
    yieldAccrued: yieldAccrued.toString(),
    attestationPayload,
  };
}

export function createGetBalanceTool(ctx: ActionContext) {
  return tool({
    name: 'getBalance',
    description:
      'Returns the USDY balance for a wallet address, denominated in both raw token units and ' +
      'USD equivalent at the current DEX spot price. Also returns the USD appreciation above ' +
      'the $1.00 face value as yield accrued. Pure read — no transaction.',
    inputSchema: GetBalanceInput,
    outputSchema: GetBalanceOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: ({ user }) => executeGetBalance(ctx, user as `0x${string}`),
  });
}
