// viem chain configs for Mantle Mainnet (5000) + Mantle Sepolia (5003).
// viem ships the mainnet `mantle` chain; Sepolia is defined here.

import { type Chain, defineChain } from 'viem';
import { mantle as mantleMainnet } from 'viem/chains';
import type { EvmChainId } from './types.ts';

export { mantleMainnet };

export const mantleSepolia = defineChain({
  id: 5003,
  name: 'Mantle Sepolia',
  network: 'mantle-sepolia',
  nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.sepolia.mantle.xyz'] },
    public: { http: ['https://rpc.sepolia.mantle.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Mantle Sepolia Explorer', url: 'https://explorer.sepolia.mantle.xyz' },
  },
  testnet: true,
});

/**
 * Resolve the viem chain for a given Mantle chain id.
 *
 * Uses the shared `EvmChainId` type (not an inline literal) so that adding a third
 * chain to the union forces this helper to handle it. The `satisfies never` throw
 * is the exhaustiveness check.
 */
export function chainFor(chainId: EvmChainId): Chain {
  if (chainId === 5000) return mantleMainnet;
  if (chainId === 5003) return mantleSepolia;
  throw new Error(`[@concierge/shared] chainFor: unsupported chain id: ${chainId satisfies never}`);
}
