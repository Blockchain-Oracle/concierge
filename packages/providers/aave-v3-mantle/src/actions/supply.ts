import type { Address } from '@concierge/shared';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { maxUint256 } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

const SupplyInput = z.object({
  asset: HEX_ADDRESS.describe('ERC-20 token address to supply (USDC, USDe, sUSDe, USDY, or mETH)'),
  amount: z.bigint().positive().describe('Amount in token base units (e.g. 1_000_000 for 1 USDC)'),
  onBehalfOf: HEX_ADDRESS.describe('Address that receives the aToken receipt'),
});

const SupplyOutput = z.object({
  txHash: z.string().describe('Transaction hash of the supply call'),
  attestationPayload: AttestationPayloadSchema,
});

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeSupply(ctx: ActionContext, args: z.infer<typeof SupplyInput>) {
  const { publicClient, walletClient, chainId, poolAddress } = ctx;
  if (!walletClient) throw new Error('[@concierge/aave-v3-mantle] supply: walletClient required');
  const [account] = await walletClient.getAddresses();
  if (!account) throw new Error('[@concierge/aave-v3-mantle] supply: no account in walletClient');

  const { asset, amount, onBehalfOf } = args;
  const preState = await getUserAccountData(publicClient, poolAddress, account);

  // Approve Pool to pull tokens before supply.
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
    functionName: 'supply',
    args: [asset, amount, onBehalfOf, 0], // referralCode=0
    account,
    chain: walletClient.chain ?? null,
  });

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
      'Supply an asset to Aave V3 on Mantle, minting aTokens to onBehalfOf. Approves the Pool automatically.',
    inputSchema: SupplyInput,
    outputSchema: SupplyOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeSupply(ctx, args),
  });
}
