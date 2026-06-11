// The E-Mode pre-check is the load-bearing safety rail in this file.
// Aave's Pool.borrow() returns 0 SILENTLY when sUSDe LTV=0 (general mode, no E-Mode 1).
// We detect this client-side by reading getUserEMode BEFORE submitting the transaction.

import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { erc20Abi, ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import type { PublicClient } from 'viem';
import { parseAbi } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

// getUserEMode is not in the shared ipoolAbi — add inline to avoid modifying shared package.
const getUserEModeAbi = parseAbi(['function getUserEMode(address user) view returns (uint256)']);

const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

const BorrowInput = z.object({
  asset: HEX_ADDRESS.describe('ERC-20 token address to borrow (USDC, USDe, or USDT0 in E-Mode 1)'),
  amount: z.bigint().positive().describe('Amount in token base units'),
  onBehalfOf: HEX_ADDRESS.describe('Address that incurs the debt'),
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
  const [eModeCategoryRaw, sUsdeBalance] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: getUserEModeAbi,
      functionName: 'getUserEMode',
      args: [account],
    }),
    publicClient.readContract({
      address: sUsdeAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
  ]);
  const eModeCategory = Number(eModeCategoryRaw);
  if (eModeCategory === 0 && sUsdeBalance > 0n) {
    throw new ConciergeError(
      'EModeNotEnabled',
      '[@concierge/aave-v3-mantle] borrow: user has sUSDe as collateral but E-Mode 1 is not active. Call setUserEMode(1) to avoid a silent zero-return from Pool.borrow().',
      undefined,
      { sUsdeBalance: sUsdeBalance.toString(), eModeCategory },
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
    async invoke({ asset, amount, onBehalfOf }) {
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
        args: [asset, amount, 2n, 0, onBehalfOf], // interestRateMode=2 (variable); referralCode=0
        account,
        chain: walletClient.chain ?? null,
      });

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
