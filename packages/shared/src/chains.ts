// viem chain configs for Mantle Mainnet (5000) + Mantle Sepolia (5003).
// viem ships the mainnet `mantle` chain; Sepolia is defined here.

import { defineChain } from 'viem';
import { mantle as mantleMainnet } from 'viem/chains';

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

/** Helper: resolve the viem chain for a given Mantle chain id. */
export function chainFor(chainId: 5000 | 5003) {
  if (chainId === 5000) return mantleMainnet;
  if (chainId === 5003) return mantleSepolia;
  throw new Error(`Unsupported chain id: ${chainId}`);
}
