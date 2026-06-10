import { describe, expect, it } from 'vitest';
import { CONCIERGE_ERROR_TYPES, ConciergeError, type ConciergeErrorType } from '../errors.ts';

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
    expect(CONCIERGE_ERROR_TYPES).toHaveLength(7);
    for (const type of CONCIERGE_ERROR_TYPES) {
      expect(new ConciergeError(type, type).type).toBe(type);
    }
  });
});
