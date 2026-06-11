import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import type { CarryVsAaveResult } from '../_types.ts';
import { executeGetYieldRate } from './getYieldRate.ts';

// RAY = 1e27 — Aave stores per-year APR in RAY units in currentVariableBorrowRate.
const RAY = 1_000_000_000_000_000_000_000_000_000n;

const poolAbi = parseAbi([
  'function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)',
]);

export const GetCarryVsAaveInput = z.object({
  spreadFloor: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      'Minimum acceptable carry in bps (default 0). Agent refuses new borrows when carryBps < spreadFloor.',
    ),
});

export const GetCarryVsAaveOutput = z.object({
  susdeYieldBps: z.number(),
  usdcBorrowBps: z.number(),
  carryBps: z.number().describe('susdeYieldBps - usdcBorrowBps; negative when carry inverts'),
  spreadFloorPassing: z
    .boolean()
    .describe('false → agent must refuse new borrow positions (carry inversion guard)'),
});

export async function executeGetCarryVsAave(
  ctx: ActionContext,
  spreadFloor: number,
): Promise<CarryVsAaveResult> {
  const [yieldRate, reserveData] = await Promise.all([
    executeGetYieldRate(ctx),
    ctx.publicClient.readContract({
      address: ctx.addresses.aavePool,
      abi: poolAbi,
      functionName: 'getReserveData',
      args: [ctx.addresses.usdc],
    }),
  ]);

  // Index 4 = currentVariableBorrowRate (RAY-scaled, per-year APR).
  const currentVariableBorrowRate = reserveData[4];
  if (currentVariableBorrowRate === undefined) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/ethena-susde] getCarryVsAave: unexpected getReserveData tuple shape',
    );
  }

  const usdcBorrowBps = Number((currentVariableBorrowRate * 10_000n) / RAY);
  const carryBps = yieldRate.susdeYieldBps - usdcBorrowBps;

  return {
    susdeYieldBps: yieldRate.susdeYieldBps,
    usdcBorrowBps,
    carryBps,
    spreadFloorPassing: carryBps >= spreadFloor,
  };
}

export function createGetCarryVsAaveTool(ctx: ActionContext) {
  return tool({
    name: 'getCarryVsAave',
    description:
      'Computes the sUSDe basis-trade carry vs Aave USDC borrow APR. ' +
      'Called every agent tick — returns spreadFloorPassing: false to block new borrow positions when carry inverts. ' +
      'Pure read — no transaction.',
    inputSchema: GetCarryVsAaveInput,
    outputSchema: GetCarryVsAaveOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeGetCarryVsAave(ctx, args.spreadFloor),
  });
}
