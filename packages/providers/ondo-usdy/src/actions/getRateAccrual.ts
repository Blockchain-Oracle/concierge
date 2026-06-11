import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import { computePriceFromSqrt, fetchPoolState } from '../_agni.ts';
import type { ActionContext } from '../_context.ts';
import { NON_NEG_INT_STR, POSITIVE_INT_STR } from '../_validators.ts';

export const GetRateAccrualInput = z.object({});

export const GetRateAccrualOutput = z.object({
  multiplier: POSITIVE_INT_STR.describe(
    'Current DEX spot price of USDY in USDC, expressed as 1e18-scaled integer (1e18 = $1.00)',
  ),
  rateMantissa: z
    .literal('0')
    .describe(
      'Always 0 — Mantle USDY has no on-chain accrual oracle. Yield is encoded in token price.',
    ),
  lastUpdateBlock: NON_NEG_INT_STR.describe('Block number at which this observation was taken'),
});

export async function executeGetRateAccrual(ctx: ActionContext) {
  const [poolState, blockNumber] = await Promise.all([
    fetchPoolState(ctx.publicClient, ctx.addresses.agniUsdyUsdc, 'getRateAccrual'),
    ctx.publicClient.getBlockNumber().catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        '[@concierge/ondo-usdy] getRateAccrual: failed to fetch block number',
        err instanceof Error ? err : undefined,
      );
    }),
  ]);

  const multiplier = computePriceFromSqrt(poolState.sqrtPriceX96);

  return {
    multiplier: multiplier.toString(),
    rateMantissa: '0' as const,
    lastUpdateBlock: blockNumber.toString(),
  };
}

export function createGetRateAccrualTool(ctx: ActionContext) {
  return tool({
    name: 'getRateAccrual',
    description:
      'Returns the current USDY token price from the Agni DEX as a 1e18-scaled multiplier ' +
      '(e.g. 1_067_000_000_000_000_000 = $1.067). Mantle USDY has no on-chain rebase oracle — ' +
      'yield accrues via token price appreciation tracked by the DEX. Pure read — no transaction.',
    inputSchema: GetRateAccrualInput,
    outputSchema: GetRateAccrualOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: () => executeGetRateAccrual(ctx),
  });
}
