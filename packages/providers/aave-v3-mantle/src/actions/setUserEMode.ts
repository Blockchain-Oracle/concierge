import type { Address } from '@concierge/shared';
import { ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { AttestationPayloadSchema, buildAttestationPayload } from '../attestation.ts';
import { getUserAccountData } from '../selectors.ts';

const SetUserEModeInput = z.object({
  categoryId: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .describe(
      '0 = general mode, 1 = sUSDe Stablecoins (LTV 90% / LT 92%), 2 = USDe Stablecoins (LTV 90% / LT 93%)',
    ),
});

const SetUserEModeOutput = z.object({
  txHash: z.string().describe('Transaction hash of the setUserEMode call'),
  categoryId: z.number().describe('The E-Mode category that is now active'),
  attestationPayload: AttestationPayloadSchema,
});

export function createSetUserEModeTool(ctx: ActionContext) {
  return tool({
    name: 'setUserEMode',
    description:
      "Toggle the user's Aave V3 E-Mode category. " +
      'Must be called with categoryId=1 before borrowing against sUSDe collateral. ' +
      "Will revert if existing borrows are outside the new E-Mode category's borrowable list.",
    inputSchema: SetUserEModeInput,
    outputSchema: SetUserEModeOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    async invoke({ categoryId }) {
      const { publicClient, walletClient, chainId, poolAddress } = ctx;
      if (!walletClient)
        throw new Error(
          '[@concierge/aave-v3-mantle] setUserEMode: walletClient is required for write operations',
        );

      const [account] = await walletClient.getAddresses();
      if (!account)
        throw new Error('[@concierge/aave-v3-mantle] setUserEMode: no account in walletClient');

      const preState = await getUserAccountData(publicClient, poolAddress, account);

      const txHash = await walletClient.writeContract({
        address: poolAddress,
        abi: ipoolAbi,
        functionName: 'setUserEMode',
        args: [categoryId],
        account,
        chain: walletClient.chain ?? null,
      });

      const postState = await getUserAccountData(publicClient, poolAddress, account);

      const attestationPayload = buildAttestationPayload({
        action: 'setUserEMode',
        chainId,
        pool: poolAddress,
        asset: '0x0000000000000000000000000000000000000000' as Address,
        amountBase: 0n,
        txHash,
        preHF: preState.healthFactor,
        postHF: postState.healthFactor,
        eMode: categoryId,
      });

      return { txHash, categoryId, attestationPayload };
    },
  });
}
