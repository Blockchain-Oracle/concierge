import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from '@concierge/shared';
import { tool } from '@concierge/tools';
import type { TransactionReceipt } from 'viem';
import { decodeEventLog, encodeEventTopics, parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_ZERO_ADDRESS } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData, getUserEMode } from '../selectors.ts';

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

// Pre-compute the RewardsClaimed topic hash so we only decode matching logs.
const REWARDS_CLAIMED_TOPIC = encodeEventTopics({ abi: rewardsClaimedEventAbi })[0];

function parseRewardsClaimed(receipt: TransactionReceipt): {
  rewardsList: string[];
  claimedAmounts: string[];
} {
  const rewardsList: string[] = [];
  const claimedAmounts: string[] = [];
  for (const log of receipt.logs) {
    if (log.topics[0] !== REWARDS_CLAIMED_TOPIC) continue;
    try {
      const { args } = decodeEventLog({
        abi: rewardsClaimedEventAbi,
        eventName: 'RewardsClaimed',
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (args.reward && args.amount !== undefined) {
        rewardsList.push(args.reward);
        claimedAmounts.push(args.amount.toString());
      }
    } catch {
      // A log matched the topic but failed to decode — surface for diagnostics.
      process.stderr.write(
        `[claimRewards] WARN: failed to decode RewardsClaimed event in tx ${receipt.transactionHash}\n`,
      );
    }
  }
  return { rewardsList, claimedAmounts };
}

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function executeClaimRewards(ctx: ActionContext, args: z.infer<typeof ClaimRewardsInput>) {
  const { publicClient, chainId, poolAddress, incentivesControllerAddress } = ctx;
  if (!incentivesControllerAddress) {
    throw new ConciergeError(
      'NetworkUnsupported',
      '[@concierge/aave-v3-mantle] claimRewards: incentives controller is not deployed on this chain. Use Mantle Mainnet or provide an incentivesController override.',
    );
  }
  const { walletClient, account } = await requireWallet(ctx, 'claimRewards');

  const { assets, to } = args;
  const [preState, eMode] = await Promise.all([
    getUserAccountData(publicClient, poolAddress, account),
    getUserEMode(publicClient, poolAddress, account),
  ]);

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: incentivesControllerAddress as Address,
      abi: rewardsControllerAbi,
      functionName: 'claimAllRewards',
      args: [assets, to],
      account,
      chain: walletClient.chain ?? null,
    });
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] claimRewards: claimAllRewards() failed on controller ${incentivesControllerAddress}. Verify the assets array contains valid aToken/debtToken addresses.`,
      err instanceof Error ? err : undefined,
      { incentivesControllerAddress, assets },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/aave-v3-mantle] claimRewards: tx ${txHash} was mined but REVERTED. Verify the assets array contains valid aToken/debtToken addresses with accrued rewards.`,
      undefined,
      { txHash },
    );
  }

  const postState = await getUserAccountData(publicClient, poolAddress, account);
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
    eMode,
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
