import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { resolveChainConfig, rpcCatch } from '../internal.ts';

describe('rpcCatch', () => {
  function invoke(cb: (err: unknown) => never, err: unknown): unknown {
    try {
      cb(err);
    } catch (e) {
      return e;
    }
  }

  it('wraps an Error as ConciergeError(RpcError) with identity-equal cause', () => {
    const original = new Error('network timeout');
    const thrown = invoke(rpcCatch('test-op', 'mantle-sepolia'), original);
    expect(thrown).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError' && e.cause === original,
    );
  });

  it('includes op and chain in the error message', () => {
    const thrown = invoke(rpcCatch('myOp', 'mantle-mainnet'), new Error('x'));
    expect(thrown).toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        String(e.message).includes('myOp') &&
        String(e.message).includes('mantle-mainnet'),
    );
  });

  it('wraps a plain string value as cause', () => {
    const thrown = invoke(rpcCatch('test-op', 'mantle-sepolia'), 'plain string error');
    expect(thrown).toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'RpcError' && e.cause === 'plain string error',
    );
  });

  it('wraps null as cause without crashing', () => {
    const thrown = invoke(rpcCatch('test-op', 'mantle-sepolia'), null);
    expect(thrown).toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('always throws — never returns', () => {
    expect(() => rpcCatch('test-op', 'mantle-sepolia')(new Error('x'))).toThrow(ConciergeError);
  });
});

describe('resolveChainConfig', () => {
  // biome-ignore lint/suspicious/noExplicitAny: chain param intentionally accepts invalid values in tests
  function tryGet(callerName: string, chain: any, apiKey: string | undefined): unknown {
    try {
      resolveChainConfig(callerName, chain, apiKey);
    } catch (e) {
      return e;
    }
  }

  it('throws ConfigError for unsupported chain', () => {
    expect(tryGet('test', 'ethereum-mainnet', 'key')).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('throws ConfigError when apiKey is undefined', () => {
    expect(tryGet('test', 'mantle-sepolia', undefined)).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('throws ConfigError when apiKey is an empty string', () => {
    expect(tryGet('test', 'mantle-sepolia', '')).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('returns bundlerUrl containing the apiKey', () => {
    const { bundlerUrl } = resolveChainConfig('test', 'mantle-sepolia', 'my-test-key');
    expect(bundlerUrl).toContain('my-test-key');
  });

  it('includes callerName in ConfigError messages', () => {
    expect(tryGet('myFunc', 'mantle-sepolia', undefined)).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && String(e.message).includes('myFunc'),
    );
  });
});
