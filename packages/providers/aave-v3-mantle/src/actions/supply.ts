import { ConciergeError } from '@concierge/sdk';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_ZERO_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData, getUserEMode } from '../selectors.ts';

const SupplyInput = z.object({
  asset: NON_ZERO_ADDRESS.describe(
    'ERC-20 token address to supply (USDC, USDe, sUSDe, USDY, or mETH)',
  ),
  amount: POSITIVE_BIGINT.describe('Amount in token base units (e.g. 1_000_000 for 1 USDC)'),
});

const SupplyOutput = z.object({
  txHash: z.string().describe('Transaction hash of the supply call'),
  attestationPayload: AttestationPayloadSchema,
});

async function ensureApproval(
  ctx: ActionContext,
  asset: `0x${string}`,
  amount: bigint,
  account: `0x${string}`,
) {
  const { publicClient, walletClient, poolAddress } = ctx;
  const allowance = await publicClient.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, poolAddress],
  });
  if (allowance >= amount) return;
  const approveTxHash = await walletClient!.writeContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'approve',
    args: [poolAddress, maxUint256],
    account,
    chain: walletClient!.chain ?? null,
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
  if (approveReceipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] supply: ERC-20 approve() for ${asset} was mined but REVERTED. Some tokens (e.g. USDT) require zeroing the allowance first: call approve(${poolAddress}, 0) then retry.`,
      undefined,
      { asset, poolAddress },
    );
  }
}

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeSupply(ctx: ActionContext, args: z.infer<typeof SupplyInput>) {
  const { publicClient, chainId, poolAddress } = ctx;
  const { walletClient, account } = await requireWallet(ctx, 'supply');

  const { asset, amount } = args;
  const [preState, eMode] = await Promise.all([
    getUserAccountData(publicClient, poolAddress, account),
    getUserEMode(publicClient, poolAddress, account),
  ]);
  let txHash: `0x${string}`;
  try {
    await ensureApproval(ctx, asset, amount, account);
    txHash = await walletClient.writeContract({
      address: poolAddress,
      abi: ipoolAbi,
      functionName: 'supply',
      args: [asset, amount, account, 0],
      account,
      chain: walletClient.chain ?? null,
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] supply: Pool.supply() failed for asset ${asset}. Verify the asset is supported by the Aave V3 pool.`,
      err instanceof Error ? err : undefined,
      { asset, poolAddress },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] supply: tx ${txHash} was mined but REVERTED. Verify the ${asset} supply cap has not been reached.`,
      undefined,
      { txHash, asset },
    );
  }
  const postState = await getUserAccountData(publicClient, poolAddress, account);
  const attestationPayload = buildAttestationPayload({
    action: 'supply',
    chainId,
    pool: poolAddress,
    asset,
    amountBase: amount,
    txHash,
    preHF: preState.healthFactor,
    postHF: postState.healthFactor,
    eMode,
  });
  return { txHash, attestationPayload };
}

export function createSupplyTool(ctx: ActionContext) {
  return tool({
    name: 'supply',
    description:
      'Supply an asset to Aave V3 on Mantle, minting aTokens to the caller. Approves the Pool automatically.',
    inputSchema: SupplyInput,
    outputSchema: SupplyOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeSupply(ctx, args),
  });
}
