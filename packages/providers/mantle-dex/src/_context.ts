import { ConciergeError } from '@concierge/sdk';
import type { Address, EvmChainId } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';

export interface DexAddresses {
  merchantMoe: { lbRouter: Address; lbQuoter: Address };
  agni: { swapRouter: Address; quoterV2: Address };
  fusionx: { swapRouter: Address; quoterV2: Address };
  woofi: { router: Address; pool: Address };
  lifi: { diamond: Address };
}

export interface ActionContext {
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient | undefined;
  readonly chainId: EvmChainId;
  readonly addresses: DexAddresses;
}

export async function requireWallet(
  ctx: ActionContext,
  action: string,
): Promise<{ walletClient: WalletClient; account: Address }> {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/mantle-dex] ${action}: walletClient is required for write operations.`,
    );
  }
  const account = ctx.walletClient.account?.address as Address | undefined;
  if (!account) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/mantle-dex] ${action}: walletClient has no bound account. Pass an explicit account to createWalletClient({ account: privateKeyToAccount(...) }).`,
    );
  }
  return { walletClient: ctx.walletClient, account };
}
