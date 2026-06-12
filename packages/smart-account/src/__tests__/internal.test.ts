import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { resolveChainConfig, rpcCatch, sanitizeCause } from '../internal.ts';

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
    return undefined;
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

  it('returns bundlerUrl containing the percent-encoded apiKey', () => {
    const { bundlerUrl } = resolveChainConfig('test', 'mantle-sepolia', 'key+with/special=chars');
    expect(bundlerUrl).toContain('key%2Bwith%2Fspecial%3Dchars');
  });

  it('includes callerName in ConfigError messages', () => {
    expect(tryGet('myFunc', 'mantle-sepolia', undefined)).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && String(e.message).includes('myFunc'),
    );
  });
});

const SANITIZE_KEY = 'secret-api-key';

describe('sanitizeCause — passthrough', () => {
  it('returns non-Error, non-string values unchanged (identity-equal)', () => {
    const obj = { foo: 'bar' };
    expect(sanitizeCause(obj, SANITIZE_KEY)).toBe(obj);
    expect(sanitizeCause(null, SANITIZE_KEY)).toBeNull();
    expect(sanitizeCause(undefined, SANITIZE_KEY)).toBeUndefined();
    expect(sanitizeCause(42, SANITIZE_KEY)).toBe(42);
  });

  it('returns a non-matching Error unchanged (identity-equal)', () => {
    const err = new TypeError('unrelated error');
    expect(sanitizeCause(err, SANITIZE_KEY)).toBe(err);
  });

  it('returns a non-matching string unchanged', () => {
    expect(sanitizeCause('harmless error', SANITIZE_KEY)).toBe('harmless error');
  });

  it('returns err unchanged when apiKey is empty string (avoids corrupting every message)', () => {
    const err = new Error(`msg with ${SANITIZE_KEY}`);
    expect(sanitizeCause(err, '')).toBe(err);
    expect(sanitizeCause(`url?apikey=${SANITIZE_KEY}`, '')).toBe(`url?apikey=${SANITIZE_KEY}`);
  });

  it('redacts apiKey from matching string', () => {
    const result = sanitizeCause(`url?apikey=${SANITIZE_KEY}`, SANITIZE_KEY);
    expect(result).toBe('url?apikey=[REDACTED]');
  });
});

describe('sanitizeCause — Error redaction', () => {
  it('preserves prototype identity when redacting Error.message', () => {
    const err = new TypeError(`fetch failed with apikey=${SANITIZE_KEY}`);
    const result = sanitizeCause(err, SANITIZE_KEY);
    expect(result).toBeInstanceOf(TypeError);
    expect((result as Error).message).toBe('fetch failed with apikey=[REDACTED]');
    expect((result as TypeError).message).not.toContain(SANITIZE_KEY);
  });

  it('scrubs apiKey from both Error.message and Error.stack', () => {
    const err = new Error(`msg with ${SANITIZE_KEY}`);
    err.stack = `Error: msg with ${SANITIZE_KEY}\n    at somewhere`;
    const result = sanitizeCause(err, SANITIZE_KEY) as Error;
    expect(result.stack).not.toContain(SANITIZE_KEY);
    expect(result.stack).toContain('[REDACTED]');
    expect(result.message).toBe(`msg with [REDACTED]`);
  });

  it('redacts when only stack (not message) contains the apiKey', () => {
    const err = new Error('clean message');
    err.stack = `Error: clean message\n    at https://host/rpc?apikey=${SANITIZE_KEY}`;
    const result = sanitizeCause(err, SANITIZE_KEY) as Error;
    expect(result.stack).not.toContain(SANITIZE_KEY);
    expect((result as Error).message).toBe('clean message');
  });
});

describe('sanitizeCause — clone fidelity', () => {
  it('preserves non-enumerable own properties (e.g. AggregateError.errors)', () => {
    const inner = new Error('inner');
    const agg = new AggregateError([inner], `agg error with ${SANITIZE_KEY}`);
    const result = sanitizeCause(agg, SANITIZE_KEY) as AggregateError;
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toBeDefined();
    expect(result.errors[0]).toBe(inner);
    expect(result.message).not.toContain(SANITIZE_KEY);
  });

  it('cloned Error.stack is non-enumerable (does not appear in JSON.stringify)', () => {
    const err = new Error(`msg with ${SANITIZE_KEY}`);
    err.stack = `Error: msg with ${SANITIZE_KEY}\n    at somewhere`;
    const result = sanitizeCause(err, SANITIZE_KEY) as Error;
    const descriptor = Object.getOwnPropertyDescriptor(result, 'stack');
    expect(descriptor?.enumerable).toBe(false);
  });
});
