import type { Address } from '@concierge/shared';
import { tool } from '@concierge/tools';
import { parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

// IRewardsController.claimAllRewards is not in the shared ipoolAbi.
const rewardsControllerAbi = parseAbi([
  'function claimAllRewards(address[] calldata assets, address to) external returns (address[] rewardsList, uint256[] claimedAmounts)',
]);

const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

const ClaimRewardsInput = z.object({
  assets: z
    .array(HEX_ADDRESS)
    .min(1)
    .describe('aToken or variableDebtToken addresses to claim rewards for (e.g. aUSDC, aUSDe)'),
  to: HEX_ADDRESS.describe('Address that receives the claimed reward tokens'),
});

const ClaimRewardsOutput = z.object({
  txHash: z.string().describe('Transaction hash of the claimAllRewards call'),
  rewardsList: z.array(z.string()).describe('Addresses of reward tokens distributed'),
  claimedAmounts: z.array(z.string()).describe('Amount claimed per reward token (base units)'),
  attestationPayload: AttestationPayloadSchema,
});

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeClaimRewards(ctx: ActionContext, args: z.infer<typeof ClaimRewardsInput>) {
  const { publicClient, walletClient, chainId, poolAddress, incentivesControllerAddress } = ctx;
  if (!walletClient)
    throw new Error(
      '[@concierge/aave-v3-mantle] claimRewards: walletClient is required for write operations',
    );

  const [account] = await walletClient.getAddresses();
  if (!account)
    throw new Error('[@concierge/aave-v3-mantle] claimRewards: no account in walletClient');

  const { assets, to } = args;
  const preState = await getUserAccountData(publicClient, poolAddress, account);

  const txHash = await walletClient.writeContract({
    address: incentivesControllerAddress,
    abi: rewardsControllerAbi,
    functionName: 'claimAllRewards',
    args: [assets, to],
    account,
    chain: walletClient.chain ?? null,
  });

  const [postState, receipt] = await Promise.all([
    getUserAccountData(publicClient, poolAddress, account),
    publicClient.waitForTransactionReceipt({ hash: txHash }),
  ]);

  // writeContract doesn't surface return values; story-67 (record phase) reads event logs.
  void receipt;
  const rewardsList: string[] = [];
  const claimedAmounts: string[] = [];

  const attestationPayload = buildAttestationPayload({
    action: 'claimRewards',
    chainId,
    pool: poolAddress,
    asset: '0x0000000000000000000000000000000000000000' as Address,
    amountBase: 0n,
    txHash,
    preHF: preState.healthFactor,
    postHF: postState.healthFactor,
    eMode: 0,
  });
  return { txHash, rewardsList, claimedAmounts, attestationPayload };
}

export function createClaimRewardsTool(ctx: ActionContext) {
  return tool({
    name: 'claimRewards',
    description:
      'Claim all accrued Aave V3 rewards (WMNT and USDC) from the Mantle Default Incentives Controller ' +
      '(0x682482a584eE20fefc01f4575c45C5d84de6F619). Pass the aToken/variableDebtToken addresses you hold.',
    inputSchema: ClaimRewardsInput,
    outputSchema: ClaimRewardsOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: (args) => executeClaimRewards(ctx, args),
  });
}
