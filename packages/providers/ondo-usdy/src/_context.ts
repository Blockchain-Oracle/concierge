import type { Address, EvmChainId } from '@concierge/shared';
import type { PublicClient } from 'viem';

export interface OndoAddresses {
  readonly usdy: Address;
  /** Agni USDY/USDC pool (500 bps fee tier) — source of DEX price and TWAP. */
  readonly agniUsdyUsdc: Address;
  /** Blocklist contract returned by USDY.blocklist() on Mantle. */
  readonly usdyBlocklist: Address;
}

export interface ActionContext {
  readonly publicClient: PublicClient;
  readonly chainId: EvmChainId;
  readonly addresses: OndoAddresses;
}
