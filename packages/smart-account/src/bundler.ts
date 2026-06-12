import { ConciergeError } from '@concierge/sdk';
import { http } from 'viem';
import {
  type BundlerClient,
  type PaymasterClient,
  createBundlerClient as viemCreateBundlerClient,
  createPaymasterClient as viemCreatePaymasterClient,
} from 'viem/account-abstraction';
import { CHAIN_CONFIGS } from './constants.ts';
import { sanitizeCause } from './internal.ts';
import type { SupportedChain } from './types.ts';

export type { BundlerClient, PaymasterClient };

/** Discriminated bundle: mainnet has null paymaster (user pays); sepolia has a live client (demo sponsorship). */
export type BundlerBundle =
  | {
      readonly chain: 'mantle-mainnet';
      readonly bundlerClient: BundlerClient;
      readonly paymasterClient: null;
    }
  | {
      readonly chain: 'mantle-sepolia';
      readonly bundlerClient: BundlerClient;
      readonly paymasterClient: PaymasterClient;
    };

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
      `[@concierge/smart-account] createBundlerClient: UnsupportedChain('${config.chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  const bundlerUrl = `${chainConfig.bundlerBaseUrl}?apikey=${encodeURIComponent(apiKey)}`;
  let bundlerClient: BundlerClient;
  try {
    bundlerClient = viemCreateBundlerClient({
      chain: chainConfig.chain,
      transport: http(bundlerUrl),
    });
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] createBundlerClient: bundler transport init failed (chain: '${config.chain}')`,
      sanitizeCause(err, apiKey),
    );
  }
  if (config.chain === 'mantle-mainnet') {
    return { chain: 'mantle-mainnet', bundlerClient, paymasterClient: null };
  }
  if (config.chain === 'mantle-sepolia') {
    let paymasterClient: PaymasterClient;
    try {
      paymasterClient = viemCreatePaymasterClient({ transport: http(bundlerUrl) });
    } catch (err) {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/smart-account] createBundlerClient: paymaster transport init failed (chain: '${config.chain}')`,
        sanitizeCause(err, apiKey),
      );
    }
    return { chain: 'mantle-sepolia', bundlerClient, paymasterClient };
  }
  const _exhaust: never = config.chain;
  void _exhaust;
  throw new ConciergeError(
    'ConfigError',
    `[@concierge/smart-account] createBundlerClient: unhandled chain '${String(config.chain)}'`,
  );
}
