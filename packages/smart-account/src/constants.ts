import { mantleMainnet, mantleSepolia } from '@concierge/shared';

export { mantleMainnet as MANTLE_MAINNET, mantleSepolia as MANTLE_SEPOLIA };

export const ENTRYPOINT_V07_ADDRESS =
  '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const satisfies `0x${string}`;

export const CHAIN_CONFIGS = {
  'mantle-mainnet': {
    chain: mantleMainnet,
    bundlerBaseUrl: 'https://api.pimlico.io/v2/mantle/rpc',
  },
  'mantle-sepolia': {
    chain: mantleSepolia,
    bundlerBaseUrl: 'https://api.pimlico.io/v2/mantle-sepolia/rpc',
  },
} as const;
