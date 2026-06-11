// The E-Mode pre-check is the load-bearing safety rail in this file.
// Aave's Pool.borrow() returns 0 SILENTLY when sUSDe LTV=0 (general mode, no E-Mode 1).
// We detect this by checking the aSUSDe aToken balance — NOT the raw sUSDe wallet balance,
// which is 0 after supply(sUSDe) moves tokens into the pool.

import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import type { PublicClient } from 'viem';
import { UserRejectedRequestError } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
import { NON_ZERO_ADDRESS, POSITIVE_BIGINT } from '../_schema.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getReserveData, getUserAccountData, getUserEMode } from '../selectors.ts';

const BorrowInput = z.object({
  asset: NON_ZERO_ADDRESS.describe(
    'ERC-20 token address to borrow (USDC, USDe, or USDT0 in E-Mode 1)',
  ),
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
  let aSUsdeAddress: Address;
  try {
    const rd = await getReserveData(publicClient, poolAddress, sUsdeAddress);
    aSUsdeAddress = rd.aTokenAddress;
  } catch (err) {
    throw ConciergeError.fromUnknown(err, 'OracleUnavailable');
  }
  const [eModeCategoryRaw, aSUsdeBalance] = await Promise.all([
    getUserEMode(publicClient, poolAddress, account),
    publicClient.readContract({
      address: aSUsdeAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
  ]);
  if (eModeCategoryRaw === 0 && aSUsdeBalance > 0n) {
    throw new ConciergeError(
      'EModeNotEnabled',
      '[@concierge/aave-v3-mantle] borrow: user has sUSDe collateral (aSUSDe > 0) but E-Mode 1 is not active. Call setUserEMode(1) to avoid a silent zero-return from Pool.borrow().',
      undefined,
      { aSUsdeBalance: aSUsdeBalance.toString(), eModeCategory: eModeCategoryRaw },
    );
  }
  return eModeCategoryRaw;
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
      const { publicClient, chainId, poolAddress, sUsdeAddress } = ctx;
      const { walletClient, account } = await requireWallet(ctx, 'borrow');

      const eModeCategory = await checkEModePreflight(
        publicClient,
        poolAddress,
        sUsdeAddress,
        account,
      );
      const preState = await getUserAccountData(publicClient, poolAddress, account);

      let txHash: `0x${string}`;
      try {
        txHash = await walletClient.writeContract({
          address: poolAddress,
          abi: ipoolAbi,
          functionName: 'borrow',
          args: [asset, amount, 2n, 0, account], // interestRateMode=2 (variable); referralCode=0
          account,
          chain: walletClient.chain ?? null,
        });
      } catch (err) {
        if (err instanceof UserRejectedRequestError) {
          throw new ConciergeError(
            'UserRejected',
            '[@concierge/aave-v3-mantle] borrow: transaction rejected by the user.',
            err,
          );
        }
        throw new ConciergeError(
          'RpcError',
          `[@concierge/aave-v3-mantle] borrow: Pool.borrow() failed. Verify E-Mode ${eModeCategory} is active and the borrow cap for ${asset} has not been reached.`,
          err instanceof Error ? err : undefined,
          { asset, poolAddress },
        );
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === 'reverted') {
        throw new ConciergeError(
          'RpcError',
          `[@concierge/aave-v3-mantle] borrow: tx ${txHash} was mined but REVERTED. Verify borrow cap and E-Mode eligibility for ${asset}.`,
          undefined,
          { txHash, asset },
        );
      }
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
