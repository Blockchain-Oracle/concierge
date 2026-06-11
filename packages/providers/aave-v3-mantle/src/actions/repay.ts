import { ConciergeError } from '@concierge/sdk';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { HEX_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData, getUserEMode } from '../selectors.ts';

const RepayInput = z.object({
  asset: HEX_ADDRESS.describe('ERC-20 debt token address to repay'),
  amount: z
    .union([POSITIVE_BIGINT, z.literal('max')])
    .describe('Amount to repay in base units, or "max" to fully clear the debt position'),
});

const RepayOutput = z.object({
  txHash: z.string().describe('Transaction hash of the repay call'),
  actualRepaid: z.string().describe('Actual amount repaid (in base units, debt-delta proxy)'),
  attestationPayload: AttestationPayloadSchema,
});

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeRepay(ctx: ActionContext, args: z.infer<typeof RepayInput>) {
  const { publicClient, chainId, poolAddress } = ctx;
  const { walletClient, account } = await requireWallet(ctx, 'repay');

  const { asset, amount } = args;
  const rawAmount = amount === 'max' ? maxUint256 : amount;
  const [preState, eMode] = await Promise.all([
    getUserAccountData(publicClient, poolAddress, account),
    getUserEMode(publicClient, poolAddress, account),
  ]);

  const allowance = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, poolAddress],
  });
  if (allowance < rawAmount) {
    const approveTxHash = await walletClient.writeContract({
      address: asset,
      abi: erc20Abi,
      functionName: 'approve',
      args: [poolAddress, maxUint256],
      account,
      chain: walletClient.chain ?? null,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (approveReceipt.status === 'reverted') {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/aave-v3-mantle] repay: ERC-20 approve() for ${asset} was mined but REVERTED. Some tokens (e.g. USDT) require zeroing the allowance first: call approve(${poolAddress}, 0) then retry.`,
        undefined,
        { asset, poolAddress },
      );
    }
  }

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: poolAddress,
      abi: ipoolAbi,
      functionName: 'repay',
      args: [asset, rawAmount, 2n, account], // interestRateMode=2 (variable)
      account,
      chain: walletClient.chain ?? null,
    });
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] repay: Pool.repay() failed. An allowance for ${poolAddress} may be live on ${asset}. Revoke with approve(${poolAddress}, 0) if needed.`,
      err instanceof Error ? err : undefined,
      { asset, poolAddress },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] repay: tx ${txHash} was mined but REVERTED. Verify the ${asset} allowance and debt balance are still valid.`,
      undefined,
      { txHash, asset },
    );
  }
  const postState = await getUserAccountData(publicClient, poolAddress, account);

  const debtDelta = preState.totalDebtBase - postState.totalDebtBase;
  // When debtDelta <= 0 (interest accrued faster than repay, or debt already 0), avoid
  // recording maxUint256 as amountBase for the 'max' path — use 0n as the safe sentinel.
  const actualRepaid = debtDelta > 0n ? debtDelta : rawAmount === maxUint256 ? 0n : rawAmount;
  const attestationPayload = buildAttestationPayload({
    action: 'repay',
    chainId,
    pool: poolAddress,
    asset,
    amountBase: actualRepaid,
    txHash,
    preHF: preState.healthFactor,
    postHF: postState.healthFactor,
    eMode,
  });
  return { txHash, actualRepaid: actualRepaid.toString(), attestationPayload };
}

export function createRepayTool(ctx: ActionContext) {
  return tool({
    name: 'repay',
    description:
      'Repay a variable-rate debt position on Aave V3 Mantle. ' +
      'Pass amount: "max" to fully clear the position — Pool pulls only the actual debt, not max-uint256 worth of tokens.',
    inputSchema: RepayInput,
    outputSchema: RepayOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeRepay(ctx, args),
  });
}
