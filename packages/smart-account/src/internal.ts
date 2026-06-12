import { ConciergeError } from '@concierge/sdk';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

/**
 * Redacts apiKey from an error's message and stack while preserving prototype identity.
 * Also handles plain string rejections. Non-matching values pass through unchanged.
 * Skips redaction when apiKey is empty to avoid corrupting every error message.
 */
export function sanitizeCause<T>(err: T, apiKey: string): T {
  if (!apiKey) return err;
  if (typeof err === 'string' && err.includes(apiKey)) {
    return err.replaceAll(apiKey, '[REDACTED]') as T;
  }
  if (err instanceof Error && (err.message.includes(apiKey) || err.stack?.includes(apiKey))) {
    const clone = Object.create(Object.getPrototypeOf(err)) as Error;
    Object.assign(clone, err);
    // Copy non-enumerable own props skipped by Object.assign (e.g. name, AggregateError.errors, code)
    for (const key of Object.getOwnPropertyNames(err)) {
      if (key === 'message' || key === 'stack') continue;
      if (!Object.hasOwn(clone, key)) {
        const descriptor = Object.getOwnPropertyDescriptor(err, key);
        if (descriptor) Object.defineProperty(clone, key, descriptor);
      }
    }
    Object.defineProperty(clone, 'message', {
      value: err.message.replaceAll(apiKey, '[REDACTED]'),
      configurable: true,
      writable: true,
      enumerable: false,
    });
    if (err.stack) {
      Object.defineProperty(clone, 'stack', {
        value: err.stack.replaceAll(apiKey, '[REDACTED]'),
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    return clone as T;
  }
  return err;
}

/**
 * Returns a .catch() callback that wraps any rejection as a sanitised RpcError.
 * Pass apiKey to redact it from the cause before wrapping.
 * Note: catches ALL rejections including programmer errors (TypeError, RangeError) —
 * always inspect `.cause` when debugging unexpected RpcErrors.
 */
export function rpcCatch(op: string, chain: SupportedChain, apiKey?: string) {
  return (err: unknown): never => {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] ${op} (chain: '${chain}')`,
      apiKey !== undefined ? sanitizeCause(err, apiKey) : err,
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
  return {
    chainConfig,
    apiKey,
    bundlerUrl: `${chainConfig.bundlerBaseUrl}?apikey=${encodeURIComponent(apiKey)}`,
  };
}
