import { ConciergeError } from '@concierge/sdk';
import { http } from 'viem';
import {
  type BundlerClient,
  type PaymasterClient,
  createBundlerClient as viemCreateBundlerClient,
  createPaymasterClient as viemCreatePaymasterClient,
} from 'viem/account-abstraction';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

export type { BundlerClient, PaymasterClient };

export interface BundlerBundle {
  bundlerClient: BundlerClient;
  paymasterClient: PaymasterClient | null;
}

export interface CreateBundlerClientConfig {
  chain: SupportedChain;
  /** Defaults to `process.env.PIMLICO_API_KEY` */
  apiKey?: string;
}

/**
 * Returns a Pimlico bundler client for the given Mantle chain.
 * For mantle-sepolia the paymaster client is set (demo sponsorship).
 * For mantle-mainnet the paymaster client is null (user pays gas in MNT).
 */
export function createBundlerClient(config: CreateBundlerClientConfig): BundlerBundle {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = config.apiKey ?? process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] createBundlerClient: MissingEnvVar('PIMLICO_API_KEY') — set this env var before creating a bundler client.",
    );
  }
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createBundlerClient: UnsupportedChain('${config.chain}')`,
    );
  }
  const bundlerUrl = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  const bundlerClient = viemCreateBundlerClient({
    chain: chainConfig.chain,
    transport: http(bundlerUrl),
  });
  const paymasterClient =
    config.chain === 'mantle-sepolia'
      ? viemCreatePaymasterClient({ transport: http(bundlerUrl) })
      : null;
  return { bundlerClient, paymasterClient };
}
