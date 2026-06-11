import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { ipoolAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { UserRejectedRequestError } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { requireWallet } from '../_context.ts';
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
      const { publicClient, chainId, poolAddress } = ctx;
      const { walletClient, account } = await requireWallet(ctx, 'setUserEMode');

      const preState = await getUserAccountData(publicClient, poolAddress, account);

      let txHash: `0x${string}`;
      try {
        txHash = await walletClient.writeContract({
          address: poolAddress,
          abi: ipoolAbi,
          functionName: 'setUserEMode',
          args: [categoryId],
          account,
          chain: walletClient.chain ?? null,
        });
      } catch (err) {
        if (err instanceof UserRejectedRequestError) {
          throw new ConciergeError(
            'UserRejected',
            '[@concierge/aave-v3-mantle] setUserEMode: transaction rejected by the user.',
            err,
          );
        }
        throw new ConciergeError(
          'RpcError',
          `[@concierge/aave-v3-mantle] setUserEMode: Pool.setUserEMode(${categoryId}) failed. Existing borrows may be outside category ${categoryId}'s borrowable asset list.`,
          err instanceof Error ? err : undefined,
          { categoryId, poolAddress },
        );
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === 'reverted') {
        throw new ConciergeError(
          'RpcError',
          `[@concierge/aave-v3-mantle] setUserEMode: tx ${txHash} was mined but REVERTED. Existing borrows are likely outside E-Mode category ${categoryId}'s borrowable asset list.`,
          undefined,
          { txHash, categoryId },
        );
      }
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
