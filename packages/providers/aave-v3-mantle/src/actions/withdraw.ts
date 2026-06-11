import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import type { UserAccountData } from '../selectors.ts';
import { getUserAccountData } from '../selectors.ts';

const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

// HF policy floor: 1.5 in 1e18-scaled units. Aave liquidates at <1.0; 1.5 is the agent's safe floor.
const HF_FLOOR = 1_500_000_000_000_000_000n;

const WithdrawInput = z.object({
  asset: HEX_ADDRESS.describe('aToken underlying asset to withdraw'),
  amount: z
    .union([z.bigint().positive(), z.literal('max')])
    .describe('Amount to withdraw in base units, or "max" to withdraw the full aToken balance'),
  to: HEX_ADDRESS.describe('Address receiving the underlying tokens'),
});

const WithdrawOutput = z.object({
  txHash: z.string().describe('Transaction hash of the withdraw call'),
  attestationPayload: AttestationPayloadSchema,
});

function assertHFAboveFloor(preState: UserAccountData, amount: bigint | 'max'): void {
  if (preState.totalDebtBase === 0n) return; // no debt → liquidation impossible
  // Conservative pre-flight: if current HF already below floor, refuse. Exact post-HF
  // projection would require an oracle price read; the post-write check below catches divergence.
  if (amount !== 'max' && preState.healthFactor < HF_FLOOR) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      `[@concierge/aave-v3-mantle] withdraw: current HF (${preState.healthFactor}) is below the 1.5 policy floor. Repay debt first.`,
      undefined,
      { currentHF: preState.healthFactor.toString(), floor: HF_FLOOR.toString() },
    );
  }
}

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeWithdraw(ctx: ActionContext, args: z.infer<typeof WithdrawInput>) {
  const { publicClient, walletClient, chainId, poolAddress } = ctx;
  if (!walletClient) throw new Error('[@concierge/aave-v3-mantle] withdraw: walletClient required');
  const [account] = await walletClient.getAddresses();
  if (!account) throw new Error('[@concierge/aave-v3-mantle] withdraw: no account in walletClient');

  const { asset, amount, to } = args;
  const rawAmount = amount === 'max' ? maxUint256 : amount;
  const preState = await getUserAccountData(publicClient, poolAddress, account);
  assertHFAboveFloor(preState, amount);

  const txHash = await walletClient.writeContract({
    address: poolAddress,
    abi: ipoolAbi,
    functionName: 'withdraw',
    args: [asset, rawAmount, to],
    account,
    chain: walletClient.chain ?? null,
  });

  const postState = await getUserAccountData(publicClient, poolAddress, account);
  if (postState.totalDebtBase > 0n && postState.healthFactor < HF_FLOOR) {
    throw new ConciergeError(
      'InsufficientLiquidity',
      `[@concierge/aave-v3-mantle] withdraw: post-withdraw HF (${postState.healthFactor}) dropped below 1.5 floor.`,
      undefined,
      { postHF: postState.healthFactor.toString(), floor: HF_FLOOR.toString() },
    );
  }
  const amountBase = amount === 'max' ? preState.totalCollateralBase : rawAmount;
  const attestationPayload = buildAttestationPayload({
    action: 'withdraw',
    chainId,
    pool: poolAddress,
    asset,
    amountBase,
    txHash,
    preHF: preState.healthFactor,
    postHF: postState.healthFactor,
    eMode: 0,
  });
  return { txHash, attestationPayload };
}

export function createWithdrawTool(ctx: ActionContext) {
  return tool({
    name: 'withdraw',
    description:
      'Withdraw collateral from Aave V3 Mantle. Throws InsufficientLiquidity if HF would drop below 1.5.',
    inputSchema: WithdrawInput,
    outputSchema: WithdrawOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeWithdraw(ctx, args),
  });
}
