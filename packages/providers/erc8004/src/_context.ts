import type { Address } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';

export interface ActionContext {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
  readonly chainId: 5000 | 5003;
}
