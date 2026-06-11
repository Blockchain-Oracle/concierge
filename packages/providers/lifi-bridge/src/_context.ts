import type { EvmChainId } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';

export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as const;
export const LIFI_API = 'https://li.quest/v1' as const;
export const ROUTE_TTL_MS = 30_000;

export interface ActionContext {
  readonly publicClient: PublicClient | undefined;
  readonly walletClient: WalletClient | undefined;
  readonly chainId: EvmChainId;
  readonly apiKey: string | undefined;
  readonly integrator: string;
  readonly lifiDiamond: typeof LIFI_DIAMOND;
}
