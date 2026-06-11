// The E-Mode pre-check is the load-bearing safety rail in this file.
// Aave's Pool.borrow() returns 0 SILENTLY when sUSDe LTV=0 (general mode, no E-Mode 1).
// We detect this by checking the aSUSDe aToken balance — NOT the raw sUSDe wallet balance,
// which is 0 after supply(sUSDe) moves tokens into the pool.

import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import type { PublicClient } from 'viem';
import { parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { HEX_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getReserveData, getUserAccountData } from '../selectors.ts';

// getUserEMode is not in the shared ipoolAbi — add inline to avoid modifying shared package.
const getUserEModeAbi = parseAbi(['function getUserEMode(address user) view returns (uint256)']);

const BorrowInput = z.object({
  asset: HEX_ADDRESS.describe('ERC-20 token address to borrow (USDC, USDe, or USDT0 in E-Mode 1)'),
  amount: POSITIVE_BIGINT.describe('Amount in token base units'),
});

const BorrowOutput = z.object({
  txHash: z.string().describe('Transaction hash of the borrow call'),
  attestationPayload: AttestationPayloadSchema,
});

// Extracted to satisfy biome noExcessiveLinesPerFunction (≤50 lines each).
async function checkEModePreflight(
  publicClient: PublicClient,
  poolAddress: Address,
  sUsdeAddress: Address,
  account: Address,
): Promise<number> {
  const { aTokenAddress: aSUsdeAddress } = await getReserveData(
    publicClient,
    poolAddress,
    sUsdeAddress,
  );
  const [eModeCategoryRaw, aSUsdeBalance] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: getUserEModeAbi,
      functionName: 'getUserEMode',
      args: [account],
    }),
    publicClient.readContract({
      address: aSUsdeAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
  ]);
  const eModeCategory = Number(eModeCategoryRaw);
  if (eModeCategory === 0 && aSUsdeBalance > 0n) {
    throw new ConciergeError(
      'EModeNotEnabled',
      '[@concierge/aave-v3-mantle] borrow: user has sUSDe collateral (aSUSDe > 0) but E-Mode 1 is not active. Call setUserEMode(1) to avoid a silent zero-return from Pool.borrow().',
      undefined,
      { aSUsdeBalance: aSUsdeBalance.toString(), eModeCategory },
    );
  }
  return eModeCategory;
}

export function createBorrowTool(ctx: ActionContext) {
  return tool({
    name: 'borrow',
    description:
      'Borrow an asset from Aave V3 on Mantle (variable rate, referralCode=0). ' +
      'Requires E-Mode 1 active when sUSDe is the collateral — call setUserEMode(1) first.',
    inputSchema: BorrowInput,
    outputSchema: BorrowOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    async invoke({ asset, amount }) {
      const { publicClient, walletClient, chainId, poolAddress, sUsdeAddress } = ctx;
      if (!walletClient)
        throw new Error('[@concierge/aave-v3-mantle] borrow: walletClient required');
      const [account] = await walletClient.getAddresses();
      if (!account)
        throw new Error('[@concierge/aave-v3-mantle] borrow: no account in walletClient');

      const eModeCategory = await checkEModePreflight(
        publicClient,
        poolAddress,
        sUsdeAddress,
        account,
      );
      const preState = await getUserAccountData(publicClient, poolAddress, account);

      const txHash = await walletClient.writeContract({
        address: poolAddress,
        abi: ipoolAbi,
        functionName: 'borrow',
        args: [asset, amount, 2n, 0, account], // interestRateMode=2 (variable); referralCode=0
        account,
        chain: walletClient.chain ?? null,
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      const postState = await getUserAccountData(publicClient, poolAddress, account);
      const attestationPayload = buildAttestationPayload({
        action: 'borrow',
        chainId,
        pool: poolAddress,
        asset,
        amountBase: amount,
        txHash,
        preHF: preState.healthFactor,
        postHF: postState.healthFactor,
        eMode: eModeCategory,
      });
      return { txHash, attestationPayload };
    },
  });
}
