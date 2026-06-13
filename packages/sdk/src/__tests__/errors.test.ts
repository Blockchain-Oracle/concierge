import { describe, expect, it } from 'vitest';
import {
  CONCIERGE_ERROR_TYPES,
  ConciergeError,
  type ConciergeErrorType,
  ConfigError,
  isConciergeErrorType,
} from '../errors.ts';

describe('ConciergeError (ADR-019)', () => {
  it('is an Error subclass with name "ConciergeError"', () => {
    const err = new ConciergeError('RpcError', 'rpc unreachable');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConciergeError);
    expect(err.name).toBe('ConciergeError');
    expect(err.message).toBe('rpc unreachable');
  });

  it('carries the type discriminator for switch-based handling', () => {
    const err = new ConciergeError('EModeNotEnabled', 'enable E-Mode 1 before sUSDe borrow');
    expect(err.type).toBe('EModeNotEnabled');
  });

  it('preserves the cause when provided', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new ConciergeError('RpcError', 'rpc unreachable', cause);
    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when omitted', () => {
    expect(new ConciergeError('UserRejected', 'no goal set').cause).toBeUndefined();
  });

  it('does NOT install a cause property when omitted (native Error semantics)', () => {
    // Native `new Error('m')` has no own `cause`; only `new Error('m', { cause })`
    // installs one. `'cause' in err` must distinguish "no cause" from
    // "cause: undefined" the same way.
    expect('cause' in new ConciergeError('UserRejected', 'no goal set')).toBe(false);
  });

  it('keeps cause non-enumerable so serializing the error never leaks the raw cause', () => {
    // A viem revert as cause can carry large/sensitive payloads (calldata,
    // RPC URLs). Native ErrorOptions installs cause non-enumerable; the SDK
    // must not downgrade that to an enumerable field.
    const err = new ConciergeError('RpcError', 'rpc unreachable', new Error('ECONNREFUSED'));
    expect(Object.keys(err)).not.toContain('cause');
    expect(JSON.stringify(err)).not.toContain('ECONNREFUSED');
  });

  it('rejects an unknown type at runtime — plain-JS callers get a loud TypeError', () => {
    // TS enforces the union at compile time, but the SDK is a public boundary:
    // a JS caller passing a typo'd type would otherwise get a switch that
    // silently matches no case.
    expect(() => new ConciergeError('RpcFailure' as ConciergeErrorType, 'x')).toThrow(TypeError);
    expect(() => new ConciergeError('RpcFailure' as ConciergeErrorType, 'x')).toThrow(
      /unknown type "RpcFailure".*EModeNotEnabled/,
    );
  });

  it('constructs for every ADR-019 error type (runtime list drives the loop)', () => {
    expect(CONCIERGE_ERROR_TYPES).toHaveLength(23);
    for (const type of CONCIERGE_ERROR_TYPES) {
      expect(new ConciergeError(type, type).type).toBe(type);
    }
  });

  it.each([
    [null],
    [0],
    [''],
  ])('installs the falsy-but-defined cause %p — only undefined means "omitted"', (cause) => {
    // The discriminator is `cause === undefined`, NOT truthiness: a provider
    // that rejects with null must not have its cause silently dropped. A
    // refactor to `cause ? { cause } : undefined` would break exactly this.
    const err = new ConciergeError('RpcError', 'falsy cause', cause);
    expect('cause' in err).toBe(true);
    expect(err.cause).toBe(cause);
  });

  it('CONCIERGE_ERROR_TYPES is frozen — it IS the constructor runtime guard', () => {
    // `as const` is compile-time only; an unfrozen array lets any consumer
    // push('Whatever') and silently widen the guard for every later construction.
    expect(Object.isFrozen(CONCIERGE_ERROR_TYPES)).toBe(true);
  });

  it('push() onto the frozen list throws TypeError — loud in strict AND sloppy mode', () => {
    // Index assignment on a frozen array no-ops silently in sloppy mode, but
    // push() throws in both modes (non-writable length), so the widening
    // attack fails loudly even from a sloppy-mode consumer.
    expect(() => (CONCIERGE_ERROR_TYPES as unknown as string[]).push('Whatever')).toThrow(
      TypeError,
    );
  });

  it('type is non-writable after construction — the guard cannot be bypassed by reassignment', () => {
    const err = new ConciergeError('RpcError', 'x');
    expect(() => {
      (err as { type: string }).type = 'Whatever';
    }).toThrow(TypeError);
    expect(err.type).toBe('RpcError');
  });

  it('type is non-configurable too — defineProperty cannot bypass the guard either', () => {
    // { writable: false } alone leaves configurable: true, so
    // Object.defineProperty(err, 'type', { value: 'X' }) would still succeed.
    const err = new ConciergeError('RpcError', 'x');
    expect(() => Object.defineProperty(err, 'type', { value: 'Whatever' })).toThrow(TypeError);
    expect(err.type).toBe('RpcError');
  });

  it('isConciergeErrorType narrows arbitrary values without casts', () => {
    expect(isConciergeErrorType('EModeNotEnabled')).toBe(true);
    expect(isConciergeErrorType('RpcFailure')).toBe(false);
    expect(isConciergeErrorType(undefined)).toBe(false);
    expect(isConciergeErrorType(42)).toBe(false);
  });

  it('explicit undefined cause is treated as omitted — diverges from native Error', () => {
    // Native: `new Error('m', { cause: undefined })` installs own `cause: undefined`.
    // ConciergeError: `new ConciergeError(t, m, undefined)` is treated as 2-arg form.
    // A caller passing `cause: someVar` where `someVar` might be `undefined` at runtime
    // will silently not install the cause — this test pins that contract.
    const err = new ConciergeError('RpcError', 'x', undefined);
    expect('cause' in err).toBe(false);
  });

  it('name is non-writable, non-configurable, and non-enumerable', () => {
    // Class-field `override readonly name = '...'` creates a writable, enumerable
    // own property — inconsistent with native Error.prototype.name. This test pins
    // that the defineProperty approach achieves the correct descriptor.
    const err = new ConciergeError('RpcError', 'x');
    expect(() => {
      (err as { name: string }).name = 'Evil';
    }).toThrow(TypeError);
    const desc = Object.getOwnPropertyDescriptor(err, 'name')!;
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
    expect(desc.enumerable).toBe(false);
    expect(Object.keys(err)).not.toContain('name');
  });

  it('type is enumerable — survives JSON.stringify so structured logs carry the discriminator', () => {
    // `name` is non-enumerable (matches native Error); `type` is enumerable so it
    // appears in log serialization output. This test pins both sides of the asymmetry.
    const err = new ConciergeError('RpcError', 'x');
    expect(Object.keys(err)).toContain('type');
    const json = JSON.stringify(err);
    expect(json).toContain('"type":"RpcError"');
    expect(json).not.toContain('"name"');
  });

  it('metadata is stored and enumerable when provided', () => {
    const err = new ConciergeError('ConfigError', 'bad config', undefined, { field: 'chain' });
    expect(err.metadata).toEqual({ field: 'chain' });
    expect(Object.keys(err)).toContain('metadata');
  });

  it('metadata is absent when omitted — not installed as own property', () => {
    const err = new ConciergeError('RpcError', 'x');
    expect('metadata' in err).toBe(false);
  });

  it('metadata is non-writable after construction — sealing matches type/name strategy', () => {
    const err = new ConciergeError('RpcError', 'x', undefined, { key: 'val' });
    expect(() => {
      (err as { metadata: unknown }).metadata = { evil: true };
    }).toThrow(TypeError);
    expect(err.metadata).toEqual({ key: 'val' });
  });

  it('metadata is non-configurable — defineProperty cannot override it', () => {
    const err = new ConciergeError('RpcError', 'x', undefined, { key: 'val' });
    expect(() => Object.defineProperty(err, 'metadata', { value: {} })).toThrow(TypeError);
  });

  it('toJSON() returns type+message+metadata, omits cause+name to prevent RPC payload leaks', () => {
    const err = new ConciergeError('RpcError', 'rpc fail', new Error('raw'), { host: 'node1' });
    const json = err.toJSON();
    expect(json['type']).toBe('RpcError');
    expect(json['message']).toBe('rpc fail');
    expect(json['metadata']).toEqual({ host: 'node1' });
    expect('cause' in json).toBe(false);
    // name is non-enumerable by design — toJSON must not re-introduce it
    expect('name' in json).toBe(false);
  });

  it('toJSON() with no metadata omits the key entirely — not undefined', () => {
    const json = new ConciergeError('RpcError', 'x').toJSON();
    expect('metadata' in json).toBe(false);
  });

  it('JSON.stringify(err) delegates to toJSON() — cause never appears in wire output', () => {
    const err = new ConciergeError('RpcError', 'rpc fail', new Error('raw'), { host: 'node1' });
    const wire = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(wire['type']).toBe('RpcError');
    expect(wire['message']).toBe('rpc fail');
    expect(wire['metadata']).toEqual({ host: 'node1' });
    expect('cause' in wire).toBe(false);
    expect('name' in wire).toBe(false);
  });

  it('toJSON() converts BigInt metadata values to decimal strings — viem amounts are bigint', () => {
    // DeFi amounts from viem (e.g. Aave borrow amount) are `bigint`. Without
    // conversion, `JSON.stringify(err.toJSON())` throws "Do not know how to
    // serialize a BigInt". toJSON() must handle this in the error serialization
    // path — the one place a secondary throw is most catastrophic.
    const err = new ConciergeError('RpcError', 'borrow failed', undefined, {
      amount: 1_000_000n,
      asset: '0xabc',
    });
    const json = err.toJSON();
    expect(() => JSON.stringify(json)).not.toThrow();
    expect((json['metadata'] as Record<string, unknown>)['amount']).toBe('1000000');
    expect((json['metadata'] as Record<string, unknown>)['asset']).toBe('0xabc');
  });

  it('JSON.stringify(err) with BigInt metadata does not throw', () => {
    const err = new ConciergeError('InsufficientLiquidity', 'pool dry', undefined, {
      available: 500n,
      requested: 1000n,
    });
    expect(() => JSON.stringify(err)).not.toThrow();
    const wire = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(wire['type']).toBe('InsufficientLiquidity');
  });

  it('fromUnknown: wraps plain Error as ConciergeError without double-wrapping', () => {
    const orig = new Error('ECONNREFUSED');
    const wrapped = ConciergeError.fromUnknown(orig);
    expect(wrapped).toBeInstanceOf(ConciergeError);
    expect(wrapped.type).toBe('RpcError');
    expect(wrapped.message).toBe('ECONNREFUSED');
    expect(wrapped.cause).toBe(orig);
    // already a ConciergeError — returned as-is
    const already = new ConciergeError('OracleUnavailable', 'no price');
    expect(ConciergeError.fromUnknown(already)).toBe(already);
  });

  it('fromUnknown: wraps non-Error values (strings, null) using String()', () => {
    const s = ConciergeError.fromUnknown('timeout string');
    expect(s.message).toBe('timeout string');
    const n = ConciergeError.fromUnknown(null, 'OracleUnavailable');
    expect(n.type).toBe('OracleUnavailable');
    expect(n.message).toBe('null');
  });

  it('fromUnknown: propagates constructor TypeError for an invalid type argument', () => {
    expect(() =>
      ConciergeError.fromUnknown(new Error('x'), 'BadType' as ConciergeErrorType),
    ).toThrow(TypeError);
  });
});

describe('ConfigError (story-23, ADR-019 adapted)', () => {
  it('is instanceof both ConfigError and ConciergeError', () => {
    const err = new ConfigError('missing ANTHROPIC_API_KEY');
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(ConciergeError);
    expect(err).toBeInstanceOf(Error);
  });

  it('type discriminator is "ConfigError"', () => {
    expect(new ConfigError('x').type).toBe('ConfigError');
  });

  it('carries typed metadata with Zod issues array', () => {
    // ConfigErrorMetadata requires { issues: ZodIssue[] } — arbitrary keys accepted
    // because the interface extends Record<string, unknown>, but issues is required.
    const meta = { issues: [] as import('zod').ZodIssue[] };
    const err = new ConfigError('invalid chain id', meta);
    expect(err.metadata).toEqual(meta);
    expect(Array.isArray(err.metadata?.issues)).toBe(true);
  });

  it('toJSON() includes type+message+metadata, no name or cause', () => {
    const err = new ConfigError('bad env', { issues: [] as import('zod').ZodIssue[] });
    const json = err.toJSON();
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forces bracket notation on Record<string, unknown>
    expect(json['type']).toBe('ConfigError');
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forces bracket notation on Record<string, unknown>
    expect(json['message']).toBe('bad env');
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature forces bracket notation on Record<string, unknown>
    expect(json['metadata']).toEqual({ issues: [] });
    expect('name' in json).toBe(false);
    expect('cause' in json).toBe(false);
  });

  it('isConciergeErrorType recognises "ConfigError"', () => {
    expect(isConciergeErrorType('ConfigError')).toBe(true);
  });
});
