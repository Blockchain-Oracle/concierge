import { ConciergeError } from '@concierge/sdk';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { HEX_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

const SupplyInput = z.object({
  asset: HEX_ADDRESS.describe('ERC-20 token address to supply (USDC, USDe, sUSDe, USDY, or mETH)'),
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
  await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
}

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeSupply(ctx: ActionContext, args: z.infer<typeof SupplyInput>) {
  const { publicClient, walletClient, chainId, poolAddress } = ctx;
  if (!walletClient) throw new Error('[@concierge/aave-v3-mantle] supply: walletClient required');
  const [account] = await walletClient.getAddresses();
  if (!account) throw new Error('[@concierge/aave-v3-mantle] supply: no account in walletClient');

  const { asset, amount } = args;
  const preState = await getUserAccountData(publicClient, poolAddress, account);
  await ensureApproval(ctx, asset, amount, account);

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: poolAddress,
      abi: ipoolAbi,
      functionName: 'supply',
      args: [asset, amount, account, 0],
      account,
      chain: walletClient.chain ?? null,
    });
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] supply: Pool.supply() failed. An allowance for ${poolAddress} may be live on ${asset}. Revoke with approve(${poolAddress}, 0) if needed.`,
      err instanceof Error ? err : undefined,
      { asset, poolAddress },
    );
  }

  await publicClient.waitForTransactionReceipt({ hash: txHash });
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
    eMode: 0,
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
