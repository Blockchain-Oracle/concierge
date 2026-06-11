// Internal shared context passed to every action factory — not part of the public API.

import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';

export interface ActionContext {
  publicClient: PublicClient;
  walletClient?: WalletClient | undefined;
  chainId: EvmChainId;
  poolAddress: Address;
  oracleAddress: Address;
  // undefined when the rewards controller is not deployed on this chain (e.g. Mantle Sepolia).
  incentivesControllerAddress: Address | undefined;
  // Used in borrow's E-Mode pre-check to detect sUSDe collateral
  sUsdeAddress: Address;
}

/** Guards every write action: throws ConfigError when walletClient is absent or has no account. */
export async function requireWallet(
  ctx: ActionContext,
  action: string,
): Promise<{ walletClient: WalletClient; account: Address }> {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/aave-v3-mantle] ${action}: walletClient is required for write operations. Initialise AaveV3MantleProvider with a connected WalletClient.`,
    );
  }
  // Require the account to be explicitly bound to the wallet client.
  // getAddresses()[0] returns the node's first unlocked account — not the caller's —
  // and would silently execute against the wrong signer on any multi-account node.
  const account = ctx.walletClient.account?.address as Address | undefined;
  if (!account) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/aave-v3-mantle] ${action}: walletClient has no bound account. Pass an explicit account to createWalletClient({ account: privateKeyToAccount(...) }) or createWalletClient({ account: "0xaddr" }).`,
    );
  }
  return { walletClient: ctx.walletClient, account };
}
