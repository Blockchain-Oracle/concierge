import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';

export interface EthenaAddresses {
  readonly usde: Address;
  readonly susde: Address;
  readonly usdc: Address;
  readonly aavePool: Address;
  readonly aaveOracle: Address;
  readonly woofiRouter: Address;
}

export interface ActionContext {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient | undefined;
  readonly chainId: EvmChainId;
  readonly addresses: EthenaAddresses;
}

export async function requireWallet(
  ctx: ActionContext,
  action: string,
): Promise<{ walletClient: WalletClient; account: Address }> {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/ethena-susde] ${action}: walletClient is required for write operations.`,
    );
  }
  const account = ctx.walletClient.account?.address as Address | undefined;
  if (!account) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/ethena-susde] ${action}: walletClient has no bound account. Pass an explicit account to createWalletClient({ account: privateKeyToAccount(...) }).`,
    );
  }
  return { walletClient: ctx.walletClient, account };
}
