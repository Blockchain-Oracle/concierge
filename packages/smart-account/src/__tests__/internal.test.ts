import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { resolveChainConfig, rpcCatch, rpcCatchNoRedact, sanitizeCause } from '../internal.ts';

describe('rpcCatchNoRedact', () => {
  function invoke(cb: (err: unknown) => never, err: unknown): unknown {
    try {
      cb(err);
    } catch (e) {
      return e;
    }
  }

  it('wraps an Error as ConciergeError(RpcError) with identity-equal cause', () => {
    const original = new Error('network timeout');
    const thrown = invoke(rpcCatchNoRedact('test-op', 'mantle-sepolia'), original);
    expect(thrown).toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError' && e.cause === original,
    );
  });

  it('includes op and chain in the error message', () => {
    const thrown = invoke(rpcCatchNoRedact('myOp', 'mantle-mainnet'), new Error('x'));
    expect(thrown).toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        String(e.message).includes('myOp') &&
        String(e.message).includes('mantle-mainnet'),
    );
  });

  it('wraps a plain string value as cause', () => {
    const thrown = invoke(rpcCatchNoRedact('test-op', 'mantle-sepolia'), 'plain string error');
    expect(thrown).toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'RpcError' && e.cause === 'plain string error',
    );
  });

  it('wraps null as cause without crashing', () => {
    const thrown = invoke(rpcCatchNoRedact('test-op', 'mantle-sepolia'), null);
    expect(thrown).toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('always throws — never returns', () => {
    expect(() => rpcCatchNoRedact('test-op', 'mantle-sepolia')(new Error('x'))).toThrow(
      ConciergeError,
    );
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

describe('sanitizeCause — cause-chain recursion', () => {
  it('redacts apiKey from nested err.cause.message', () => {
    const inner = new TypeError(`inner with apikey=${SANITIZE_KEY}`);
    const outer = new Error('outer clean message', { cause: inner });
    const result = sanitizeCause(outer, SANITIZE_KEY) as Error & { cause: Error };
    expect(result.cause).toBeInstanceOf(TypeError);
    expect(result.cause.message).toBe('inner with apikey=[REDACTED]');
    expect(result.cause).not.toBe(inner);
  });

  it('redacts apiKey two levels deep (cause.cause.message)', () => {
    const root = new Error(`root with ${SANITIZE_KEY}`);
    const mid = new Error('mid clean', { cause: root });
    const top = new Error('top clean', { cause: mid });
    const result = sanitizeCause(top, SANITIZE_KEY) as Error & { cause: Error & { cause: Error } };
    expect(result.cause.cause.message).toBe('root with [REDACTED]');
  });

  it('survives cyclic cause chain without stack overflow', () => {
    const a = new Error(`a with ${SANITIZE_KEY}`);
    const b = new Error('b clean');
    // biome-ignore lint/suspicious/noExplicitAny: building a cycle for cycle-safety test
    (a as any).cause = b;
    // biome-ignore lint/suspicious/noExplicitAny: building a cycle for cycle-safety test
    (b as any).cause = a;
    const result = sanitizeCause(a, SANITIZE_KEY) as Error;
    expect(result.message).toBe('a with [REDACTED]');
  });

  it('redacts apiKey from AggregateError.errors[N].message', () => {
    const child = new Error(`child with ${SANITIZE_KEY}`);
    const agg = new AggregateError([child], 'agg clean');
    const result = sanitizeCause(agg, SANITIZE_KEY) as AggregateError;
    expect(result.errors[0]).not.toBe(child);
    expect((result.errors[0] as Error).message).toBe('child with [REDACTED]');
  });
});

describe('sanitizeCause — viem-shape error fields', () => {
  it('redacts apiKey from custom string property (e.g. viem shortMessage)', () => {
    const err = new Error('clean message');
    // biome-ignore lint/suspicious/noExplicitAny: simulating viem BaseError shape
    (err as any).shortMessage = `https://api.host/rpc?apikey=${SANITIZE_KEY}`;
    const result = sanitizeCause(err, SANITIZE_KEY) as Error & { shortMessage: string };
    expect(result.shortMessage).toBe('https://api.host/rpc?apikey=[REDACTED]');
  });

  it('redacts apiKey from string[] property (e.g. viem metaMessages)', () => {
    const err = new Error('clean message');
    // biome-ignore lint/suspicious/noExplicitAny: simulating viem BaseError shape
    (err as any).metaMessages = [
      'URL:',
      `https://api.host/rpc?apikey=${SANITIZE_KEY}`,
      'method: eth_call',
    ];
    const result = sanitizeCause(err, SANITIZE_KEY) as Error & { metaMessages: string[] };
    expect(result.metaMessages).toEqual([
      'URL:',
      'https://api.host/rpc?apikey=[REDACTED]',
      'method: eth_call',
    ]);
  });

  it('redacts apiKey from nested plain-object property (e.g. err.request.url)', () => {
    const err = new Error('clean message');
    // biome-ignore lint/suspicious/noExplicitAny: simulating SDK error with nested POJO
    (err as any).request = {
      url: `https://host/rpc?apikey=${SANITIZE_KEY}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    };
    const result = sanitizeCause(err, SANITIZE_KEY) as Error & {
      request: { url: string; method: string };
    };
    expect(result.request.url).toBe('https://host/rpc?apikey=[REDACTED]');
    expect(result.request.method).toBe('POST');
  });

  it('redacts apiKey from plain-object cause (non-Error)', () => {
    const outer = new Error('outer');
    // biome-ignore lint/suspicious/noExplicitAny: SDK sometimes wraps a POJO as cause
    (outer as any).cause = { url: `https://h/rpc?apikey=${SANITIZE_KEY}`, status: 401 };
    const result = sanitizeCause(outer, SANITIZE_KEY) as Error & {
      cause: { url: string; status: number };
    };
    expect(result.cause.url).toBe('https://h/rpc?apikey=[REDACTED]');
    expect(result.cause.status).toBe(401);
  });
});

describe('sanitizeCause — URL-encoded form', () => {
  it('redacts the encodeURIComponent form when key has special chars', () => {
    const KEY = 'key+with/special=chars';
    const encoded = encodeURIComponent(KEY);
    const err = new Error(`fetch failed: https://host/rpc?apikey=${encoded}`);
    const result = sanitizeCause(err, KEY) as Error;
    expect(result.message).not.toContain(encoded);
    expect(result.message).toContain('[REDACTED]');
  });

  it('does not double-redact when raw apiKey equals its encodeURIComponent form (alphanumeric)', () => {
    const KEY = 'abcdef123';
    const err = new Error(`apikey=${KEY}`);
    const result = sanitizeCause(err, KEY) as Error;
    expect(result.message).toBe('apikey=[REDACTED]');
    expect(result.message).not.toContain('[REDACTED][REDACTED]');
  });
});

describe('sanitizeCause — depth cap', () => {
  it('truncates with sentinel rather than silently leaking past MAX_CAUSE_DEPTH', () => {
    const leaf = new Error(`leaf with ${SANITIZE_KEY}`);
    let chain: Error = leaf;
    for (let i = 0; i < 15; i++) chain = new Error(`level-${i}`, { cause: chain });
    const result = sanitizeCause(chain, SANITIZE_KEY) as Error;
    // Walk the chain — no level should contain the raw key (either redacted or sentinel-replaced)
    let cursor: unknown = result;
    let depth = 0;
    while (cursor && depth < 20) {
      if (typeof cursor === 'string') {
        expect(cursor).not.toContain(SANITIZE_KEY);
        break;
      }
      if (cursor instanceof Error) {
        expect(cursor.message).not.toContain(SANITIZE_KEY);
        cursor = (cursor as Error & { cause?: unknown }).cause;
      } else {
        break;
      }
      depth++;
    }
    void leaf;
  });
});

describe('rpcCatch — apiKey redaction', () => {
  function invoke(cb: (err: unknown) => never, err: unknown): unknown {
    try {
      cb(err);
    } catch (e) {
      return e;
    }
  }

  it('redacts apiKey from cause.message when apiKey is provided', () => {
    const original = new TypeError(`fetch failed apikey=${SANITIZE_KEY}`);
    const thrown = invoke(rpcCatch('myOp', 'mantle-sepolia', SANITIZE_KEY), original);
    expect(thrown).toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        // biome-ignore lint/suspicious/noExplicitAny: checking cause for redaction
        !String((e as any).cause?.message ?? '').includes(SANITIZE_KEY) &&
        // biome-ignore lint/suspicious/noExplicitAny: cause should be cloned, not the original
        (e as any).cause !== original,
    );
  });

  it('throws ConfigError at construction when apiKey is empty string', () => {
    expect(() => rpcCatch('op', 'mantle-sepolia', '')).toThrow(ConciergeError);
    expect(() => rpcCatch('op', 'mantle-sepolia', '')).toThrow(/empty apiKey/);
  });
});
