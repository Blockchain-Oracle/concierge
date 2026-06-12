import { ConciergeError } from '@concierge/sdk';
import { http } from 'viem';
import {
  type PaymasterClient,
  createPaymasterClient as viemCreatePaymasterClient,
} from 'viem/account-abstraction';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

export type { PaymasterClient };

/** 'always' = Concierge sponsors gas (Sepolia demo). 'never' = user pays MNT (Mainnet). */
export type SponsorshipPolicy = 'always' | 'never';

export interface CreatePaymasterClientConfig {
  chain: SupportedChain;
  sponsorshipPolicy: SponsorshipPolicy;
  /** Defaults to `process.env.PIMLICO_API_KEY` */
  apiKey?: string;
}

/**
 * Returns a Pimlico verifying paymaster client, or null when sponsorship is 'never'.
 * Wire the returned client into createKernelAccountClient via the `paymaster` field.
 */
export function createPaymasterClient(config: CreatePaymasterClientConfig): PaymasterClient | null {
  if (config.sponsorshipPolicy === 'never') return null;
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = config.apiKey ?? process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] createPaymasterClient: MissingEnvVar('PIMLICO_API_KEY') — set this env var before creating a paymaster client.",
    );
  }
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createPaymasterClient: UnsupportedChain('${config.chain}')`,
    );
  }
  const paymasterUrl = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  return viemCreatePaymasterClient({ transport: http(paymasterUrl) });
}
