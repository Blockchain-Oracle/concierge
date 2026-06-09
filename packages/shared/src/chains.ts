// viem chain configs for Mantle Mainnet (5000) + Mantle Sepolia (5003).
// viem ships the mainnet `mantle` chain; Sepolia is defined here.

import { type Chain, defineChain } from 'viem';
import { mantle as mantleMainnet } from 'viem/chains';
import type { EvmChainId } from './types.ts';

export { mantleMainnet };

// Multicall3 is canonical at 0xcA11bde05977b3631167028862bE2a173976CA11 on most EVM chains;
// verified live on Mantle Sepolia 2026-06-09 via:
//   cast call 0xcA11bde0...6CA11 "getChainId()(uint256)" --rpc-url https://rpc.sepolia.mantle.xyz
//   → 5003 (matches network id)
// Without this entry, viem's publicClient.multicall() silently degrades to per-call eth_calls.
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
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
  testnet: true,
});

/**
 * Resolve the viem chain for a given Mantle chain id.
 *
 * Validates input type — JS↔TS boundary code (env vars, JSON config, CLI args) may
 * pass `'5000'` (string) or `5000n` (bigint) instead of the number; surface that as
 * a typed error rather than a generic "unsupported chain id".
 */
export function chainFor(chainId: EvmChainId): Chain {
  assertNumericChainId(chainId, 'chainFor');
  if (chainId === 5000) return mantleMainnet;
  if (chainId === 5003) return mantleSepolia;
  throw new Error(
    `[@concierge/shared] chainFor: unsupported Mantle chain id ${chainId satisfies never} (expected 5000 mainnet or 5003 sepolia)`,
  );
}

// Shared input-type guard: used by chainFor + addressesFor to fail fast on
// string-from-env / bigint-from-JSON-parse inputs before the value reaches
// the chain-id branches. Also rejects negatives, zero, NaN, Infinity, and
// values outside the safe-integer range (a 21-digit-or-larger JSON literal
// gets silently rounded by JSON.parse otherwise).
export function assertNumericChainId(value: unknown, fnName: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(
      `[@concierge/shared] ${fnName}: chainId must be a positive safe integer, got ${typeof value} (${JSON.stringify(String(value))}). ` +
        'If reading from env / JSON / CLI, parse with Number() first.',
    );
  }
}
