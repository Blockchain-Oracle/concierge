import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from '@concierge/shared';
import { tool } from '@concierge/tools';
import type { TransactionReceipt } from 'viem';
import { decodeEventLog, parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { NON_ZERO_ADDRESS } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

const rewardsControllerAbi = parseAbi([
  'function claimAllRewards(address[] calldata assets, address to) external returns (address[] rewardsList, uint256[] claimedAmounts)',
]);

const rewardsClaimedEventAbi = parseAbi([
  'event RewardsClaimed(address indexed user, address indexed reward, address indexed to, address caller, uint256 amount)',
]);

const ClaimRewardsInput = z.object({
  assets: z
    .array(NON_ZERO_ADDRESS)
    .min(1)
    .max(20)
    .describe('aToken or variableDebtToken addresses to claim rewards for (max 20)'),
  to: NON_ZERO_ADDRESS.describe('Address that receives the claimed reward tokens'),
});

const ClaimRewardsOutput = z.object({
  txHash: z.string().describe('Transaction hash of the claimAllRewards call'),
  rewardsList: z.array(z.string()).describe('Reward token addresses distributed'),
  claimedAmounts: z.array(z.string()).describe('Amount claimed per reward token (base units)'),
  attestationPayload: AttestationPayloadSchema,
});

function parseRewardsClaimed(receipt: TransactionReceipt): {
  rewardsList: string[];
  claimedAmounts: string[];
} {
  const rewardsList: string[] = [];
  const claimedAmounts: string[] = [];
  for (const log of receipt.logs) {
    try {
      const { args } = decodeEventLog({
        abi: rewardsClaimedEventAbi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
        strict: false,
      });
      if (args?.reward && args?.amount !== undefined) {
        rewardsList.push(args.reward as string);
        claimedAmounts.push((args.amount as bigint).toString());
      }
    } catch {
      /* not a RewardsClaimed event */
    }
  }
  return { rewardsList, claimedAmounts };
}

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeClaimRewards(ctx: ActionContext, args: z.infer<typeof ClaimRewardsInput>) {
  const { publicClient, walletClient, chainId, poolAddress, incentivesControllerAddress } = ctx;
  if (!incentivesControllerAddress) {
    throw new ConciergeError(
      'NetworkUnsupported',
      '[@concierge/aave-v3-mantle] claimRewards: incentives controller is not deployed on this chain. Use Mantle Mainnet or provide an incentivesController override.',
    );
  }
  if (!walletClient)
    throw new Error('[@concierge/aave-v3-mantle] claimRewards: walletClient required');

  const [account] = await walletClient.getAddresses();
  if (!account)
    throw new Error('[@concierge/aave-v3-mantle] claimRewards: no account in walletClient');

  const { assets, to } = args;
  const preState = await getUserAccountData(publicClient, poolAddress, account);

  const txHash = await walletClient.writeContract({
    address: incentivesControllerAddress as Address,
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

  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] claimRewards: tx ${txHash} was mined but REVERTED. Verify the assets array contains valid aToken/debtToken addresses with accrued rewards.`,
      undefined,
      { txHash },
    );
  }

  const { rewardsList, claimedAmounts } = parseRewardsClaimed(receipt);
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
