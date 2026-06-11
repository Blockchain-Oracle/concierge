import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { type PublicClient, parseAbi } from 'viem';
import { z } from 'zod';
import { computeRateFromSqrt, fetchPoolState } from '../_agni.ts';
import type { ActionContext } from '../_context.ts';
import { NON_NEG_INT_STR } from '../_validators.ts';
import {
  buildReadAttestationPayload,
  type ReadAttestationPayload,
  ReadAttestationPayloadSchema,
} from '../attestation.ts';

const ERC20_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

export const GetBalanceInput = z.object({
  user: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .describe('User wallet address'),
});

export const GetBalanceOutput = z.object({
  raw: NON_NEG_INT_STR.describe('Raw mETH balance (18 dec, bigint as string)'),
  ethValue: NON_NEG_INT_STR.describe(
    'WETH-equivalent value of mETH balance at DEX spot price (18 dec, bigint as string)',
  ),
  attestationPayload: ReadAttestationPayloadSchema.describe('ERC-8004 attestation payload'),
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
        `[@concierge/meth-staking] getBalance: failed to read mETH balance for ${user}`,
        err instanceof Error ? err : undefined,
      );
    });
}

export async function executeGetBalance(
  ctx: ActionContext,
  user: `0x${string}`,
): Promise<z.infer<typeof GetBalanceOutput>> {
  const [raw, poolState, blockNumber] = await Promise.all([
    readBalance(ctx.publicClient, ctx.addresses.meth, user),
    fetchPoolState(ctx.publicClient, ctx.addresses.agniMethWeth, 'getBalance'),
    ctx.publicClient.getBlockNumber().catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        '[@concierge/meth-staking] getBalance: failed to fetch block number for attestation',
        err instanceof Error ? err : undefined,
      );
    }),
  ]);

  const rate = computeRateFromSqrt(poolState.sqrtPriceX96);
  const ethValue = (raw * rate) / 10n ** 18n;

  let attestationPayload: ReadAttestationPayload;
  try {
    attestationPayload = buildReadAttestationPayload({
      chainId: ctx.chainId,
      user,
      balance: raw,
      exchangeRate: rate,
      blockNumber: Number(blockNumber),
    });
  } catch (err) {
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/meth-staking] getBalance: attestation payload validation failed for user ${user} at block ${blockNumber}`,
      err instanceof Error ? err : undefined,
    );
  }

  return {
    raw: raw.toString(),
    ethValue: ethValue.toString(),
    attestationPayload,
  };
}

export function createGetBalanceTool(ctx: ActionContext) {
  return tool({
    name: 'getBalance',
    description:
      'Returns the mETH balance for a wallet address, denominated in both raw mETH units and ' +
      'WETH-equivalent value at the current Agni DEX spot price. Pure read — no transaction.',
    inputSchema: GetBalanceInput,
    outputSchema: GetBalanceOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: ({ user }) => executeGetBalance(ctx, user as `0x${string}`),
  });
}
