import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { type PublicClient, parseAbi } from 'viem';

const BLOCKLIST_ABI = parseAbi(['function isBlocked(address account) view returns (bool)']);

/**
 * Returns true when the user is not on Ondo's sanctions blocklist.
 *
 * Mantle USDY is a bridge image with no on-chain KYC allowlist. KYC gating
 * applies only to L1 mint/redeem via the Ondo portal. On Mantle, only OFAC/
 * sanctions-blocked addresses are ineligible (enforced by the blocklist contract).
 */
export async function isUserEligible(
  publicClient: PublicClient,
  blocklistAddress: Address,
  user: Address,
): Promise<boolean> {
  const blocked = await publicClient
    .readContract({
      address: blocklistAddress,
      abi: BLOCKLIST_ABI,
      functionName: 'isBlocked',
      args: [user],
    })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/ondo-usdy] isUserEligible: failed to query blocklist for ${user}`,
        err instanceof Error ? err : undefined,
      );
    });
  if (typeof blocked !== 'boolean') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/ondo-usdy] isUserEligible: blocklist contract at ${blocklistAddress} returned unexpected type (${typeof blocked}); check ABI`,
    );
  }
  return !blocked;
}
