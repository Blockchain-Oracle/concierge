import { ConciergeError } from '@concierge/sdk';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import type { Hex } from 'viem';
import { decodeEventLog, encodeEventTopics, maxUint256, parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_NEG_INT_STR, NON_ZERO_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData, getUserEMode } from '../selectors.ts';

// Repay event: emitted by Aave pool on successful repayment. We parse this from the
// receipt to get the exact token-unit amount repaid — race-free vs. simulateContract.
const repayEventAbi = parseAbi([
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
]);
const REPAY_TOPIC = encodeEventTopics({ abi: repayEventAbi })[0] as Hex;

const RepayInput = z.object({
  asset: NON_ZERO_ADDRESS.describe('ERC-20 debt token address to repay'),
  amount: z
    .union([POSITIVE_BIGINT, z.literal('max')])
    .describe('Amount to repay in base units, or "max" to fully clear the debt position'),
});

const RepayOutput = z.object({
  txHash: z.string().describe('Transaction hash of the repay call'),
  actualRepaid: NON_NEG_INT_STR.describe('Actual amount repaid (in base units, debt-delta proxy)'),
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
    let approveTxHash: `0x${string}`;
    try {
      approveTxHash = await walletClient.writeContract({
        address: asset,
        abi: erc20Abi,
        functionName: 'approve',
        args: [poolAddress, maxUint256],
        account,
        chain: walletClient.chain ?? null,
      });
    } catch (err) {
      if (err instanceof ConciergeError) throw err;
      throw new ConciergeError(
        'RpcError',
        `[@concierge/aave-v3-mantle] repay: ERC-20 approve() submission for ${asset} failed. Check wallet connection and gas.`,
        err instanceof Error ? err : undefined,
        { asset, poolAddress },
      );
    }
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
    if (err instanceof ConciergeError) throw err;
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

  // Parse the Repay event from the receipt to get the exact token-unit amount repaid.
  // This is race-free: the value comes from what actually executed on-chain, not a
  // pre-tx simulation that could observe different state than what the tx landed on.
  // Filter by both event signature (topics[0]) and reserve address (topics[1], ABI-padded).
  // ABI-encoded address topic: 32 bytes = 24 zero-padding + 20-byte address.
  const paddedAsset = `0x${'0'.repeat(24)}${asset.slice(2).toLowerCase()}` as Hex;
  const repayLog = receipt.logs.find(
    (log) => log.topics[0] === REPAY_TOPIC && log.topics[1]?.toLowerCase() === paddedAsset,
  );
  if (!repayLog) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] repay: tx ${txHash} was mined but no Repay event found for asset ${asset}. The pool ABI may have changed.`,
      undefined,
      { txHash, poolAddress, asset, logCount: receipt.logs.length },
    );
  }
  let actualRepaid: bigint;
  try {
    const { args: eventArgs } = decodeEventLog({
      abi: repayEventAbi,
      eventName: 'Repay',
      data: repayLog.data as Hex,
      topics: repayLog.topics as [Hex, ...Hex[]],
    });
    actualRepaid = eventArgs.amount;
  } catch (decodeErr) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] repay: failed to decode Repay event from tx ${txHash}. Pool ABI may have changed.`,
      decodeErr instanceof Error ? decodeErr : undefined,
      { txHash, poolAddress },
    );
  }

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
