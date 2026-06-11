// Internal shared context passed to every action factory — not part of the public API.

import type { Address, EvmChainId } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';

export interface ActionContext {
  publicClient: PublicClient;
  walletClient?: WalletClient | undefined;
  chainId: EvmChainId;
  poolAddress: Address;
  oracleAddress: Address;
  incentivesControllerAddress: Address;
  // Used in borrow's E-Mode pre-check to detect sUSDe collateral
  sUsdeAddress: Address;
}
