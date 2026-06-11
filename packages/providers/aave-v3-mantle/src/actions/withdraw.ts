import { ConciergeError } from '@concierge/sdk';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { NON_ZERO_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import type { UserAccountData } from '../selectors.ts';
import { getReserveData, getUserAccountData } from '../selectors.ts';

// HF policy floor: 1.5 in 1e18-scaled units. Aave liquidates at <1.0; 1.5 is the agent's safe floor.
const HF_FLOOR = 1_500_000_000_000_000_000n;

const WithdrawInput = z.object({
  asset: NON_ZERO_ADDRESS.describe('aToken underlying asset to withdraw'),
  amount: z
    .union([POSITIVE_BIGINT, z.literal('max')])
    .describe('Amount to withdraw in base units, or "max" to withdraw the full aToken balance'),
  to: NON_ZERO_ADDRESS.describe('Address receiving the underlying tokens'),
});

const WithdrawOutput = z.object({
  txHash: z.string().describe('Transaction hash of the withdraw call'),
  attestationPayload: AttestationPayloadSchema,
  warning: z
    .string()
    .optional()
    .describe('Non-blocking alert: post-withdraw HF dropped below 1.5; withdrawal IS complete'),
});

// Exported for unit testing.
export function assertHFAboveFloor(preState: UserAccountData, amount: bigint | 'max'): void {
  if (preState.totalDebtBase === 0n) return; // no debt → liquidation impossible
  if (amount === 'max') {
    // Cannot pre-compute post-HF without an oracle call; refusing max-with-debt is the safe default.
    throw new ConciergeError(
      'InsufficientLiquidity',
      `[@concierge/aave-v3-mantle] withdraw: cannot withdraw all collateral while debt is outstanding (totalDebtBase: ${preState.totalDebtBase}). Repay all debt first.`,
      undefined,
      { totalDebtBase: preState.totalDebtBase.toString() },
    );
  }
  if (preState.healthFactor < HF_FLOOR) {
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

  // For 'max', read the exact aToken balance for accurate attestation amountBase.
  let amountBase = rawAmount;
  if (amount === 'max') {
    const { aTokenAddress } = await getReserveData(publicClient, poolAddress, asset);
    amountBase = await publicClient.readContract({
      address: aTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    });
  }

  const txHash = await walletClient.writeContract({
    address: poolAddress,
    abi: ipoolAbi,
    functionName: 'withdraw',
    args: [asset, rawAmount, to],
    account,
    chain: walletClient.chain ?? null,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  const postState = await getUserAccountData(publicClient, poolAddress, account);

  // The tx is already mined at this point — return a warning rather than throwing.
  let warning: string | undefined;
  if (postState.totalDebtBase > 0n && postState.healthFactor < HF_FLOOR) {
    warning = `Post-withdraw HF ${postState.healthFactor} is below the 1.5 floor. Withdrawal (tx ${txHash}) is COMPLETE. Repay debt immediately to avoid liquidation.`;
  }

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
  return { txHash, attestationPayload, warning };
}

export function createWithdrawTool(ctx: ActionContext) {
  return tool({
    name: 'withdraw',
    description:
      'Withdraw collateral from Aave V3 Mantle. Refuses if HF < 1.5 or if withdrawing all collateral while debt is outstanding.',
    inputSchema: WithdrawInput,
    outputSchema: WithdrawOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeWithdraw(ctx, args),
  });
}
