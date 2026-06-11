import type { Address } from '@concierge/shared';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

const RepayInput = z.object({
  asset: HEX_ADDRESS.describe('ERC-20 debt token address to repay'),
  amount: z
    .union([z.bigint().positive(), z.literal('max')])
    .describe('Amount to repay in base units, or "max" to fully clear the debt position'),
  onBehalfOf: HEX_ADDRESS.describe('Address whose debt is being repaid'),
});

const RepayOutput = z.object({
  txHash: z.string().describe('Transaction hash of the repay call'),
  actualRepaid: z.string().describe('Actual amount repaid (in base units, debt-delta proxy)'),
  attestationPayload: AttestationPayloadSchema,
});

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeRepay(ctx: ActionContext, args: z.infer<typeof RepayInput>) {
  const { publicClient, walletClient, chainId, poolAddress } = ctx;
  if (!walletClient) throw new Error('[@concierge/aave-v3-mantle] repay: walletClient required');
  const [account] = await walletClient.getAddresses();
  if (!account) throw new Error('[@concierge/aave-v3-mantle] repay: no account in walletClient');

  const { asset, amount, onBehalfOf } = args;
  const rawAmount = amount === 'max' ? maxUint256 : amount;
  const preState = await getUserAccountData(publicClient, poolAddress, account);

  await walletClient.writeContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'approve',
    args: [poolAddress, maxUint256],
    account,
    chain: walletClient.chain ?? null,
  });
  const txHash = await walletClient.writeContract({
    address: poolAddress,
    abi: ipoolAbi,
    functionName: 'repay',
    args: [asset, rawAmount, 2n, onBehalfOf], // interestRateMode=2 (variable)
    account,
    chain: walletClient.chain ?? null,
  });

  const [postState] = await Promise.all([
    getUserAccountData(publicClient, poolAddress, account),
    publicClient.waitForTransactionReceipt({ hash: txHash }), // await for confirmation
  ]);

  // Actual repaid amount is in receipt logs; debt-delta is a sufficient proxy for attestation.
  const debtDelta = preState.totalDebtBase - postState.totalDebtBase;
  const actualRepaid = debtDelta > 0n ? debtDelta : rawAmount;
  const attestationPayload = buildAttestationPayload({
    action: 'repay',
    chainId,
    pool: poolAddress,
    asset,
    amountBase: actualRepaid,
    txHash,
    preHF: preState.healthFactor,
    postHF: postState.healthFactor,
    eMode: 0,
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
