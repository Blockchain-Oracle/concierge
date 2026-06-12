import { ConciergeError } from '@concierge/sdk';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

/** Returns a .catch() callback that throws a sanitised RpcError (no API key in message). */
export function rpcCatch(op: string, chain: string) {
  return (err: unknown): never => {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] ${op} (chain: '${chain}')`,
      err,
    );
  };
}

/** Validates chain + apiKey and returns the resolved config bundle. */
export function resolveChainConfig(
  callerName: string,
  chain: SupportedChain,
  apiKey: string | undefined,
): {
  chainConfig: (typeof CHAIN_CONFIGS)[keyof typeof CHAIN_CONFIGS];
  apiKey: string;
  bundlerUrl: string;
} {
  const chainConfig = CHAIN_CONFIGS[chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] ${callerName}: UnsupportedChain('${chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] ${callerName}: MissingEnvVar('PIMLICO_API_KEY') — set this env var or pass apiKey in config.`,
    );
  }
  return { chainConfig, apiKey, bundlerUrl: `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}` };
}
