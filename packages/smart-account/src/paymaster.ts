import { ConciergeError } from '@concierge/sdk';
import { http } from 'viem';
import {
  type PaymasterClient,
  createPaymasterClient as viemCreatePaymasterClient,
} from 'viem/account-abstraction';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

/** 'always' = Concierge sponsors gas (Sepolia demo). 'never' = user pays MNT (Mainnet). */
export type SponsorshipPolicy = 'always' | 'never';

/** Discriminated config: 'never' needs no API key; 'always' requires Pimlico credentials. */
export type CreatePaymasterClientConfig =
  | { readonly chain: SupportedChain; readonly sponsorshipPolicy: 'never' }
  | {
      readonly chain: SupportedChain;
      readonly sponsorshipPolicy: 'always';
      readonly apiKey?: string;
    };

export function createPaymasterClient(
  config: Extract<CreatePaymasterClientConfig, { sponsorshipPolicy: 'never' }>,
): null;
export function createPaymasterClient(
  config: Extract<CreatePaymasterClientConfig, { sponsorshipPolicy: 'always' }>,
): PaymasterClient;
export function createPaymasterClient(config: CreatePaymasterClientConfig): PaymasterClient | null;
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
      `[@concierge/smart-account] createPaymasterClient: UnsupportedChain('${config.chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  const paymasterUrl = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  try {
    return viemCreatePaymasterClient({ transport: http(paymasterUrl) });
  } catch (err) {
    throw ConciergeError.fromUnknown(err, 'RpcError');
  }
}
