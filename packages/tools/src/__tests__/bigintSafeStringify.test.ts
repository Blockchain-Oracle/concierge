// Runtime tests for bigintSafeStringify — bigint/Map/Set conversion, circular-ref
// detection, top-level + nested data-corruption guards (function/Symbol/thenable/
// WeakMap/WeakSet), empty-string-key value-identity check, depth-3 nesting.

import { describe, expect, it } from 'vitest';
import { bigintSafeStringify } from '../bigintSafeStringify.ts';

describe('bigintSafeStringify', () => {
  it('serializes a positive bigint as a decimal string', () => {
    expect(bigintSafeStringify({ amount: 1234567890n })).toBe('{"amount":"1234567890"}');
  });

  it('serializes a negative bigint', () => {
    expect(bigintSafeStringify({ debt: -42n })).toBe('{"debt":"-42"}');
  });

  it('serializes Map entries as an object', () => {
    expect(bigintSafeStringify({ m: new Map([['a', 1n]]) })).toBe('{"m":{"a":"1"}}');
  });

  it('serializes Set entries as an array', () => {
    expect(bigintSafeStringify({ s: new Set([1n, 2n]) })).toBe('{"s":["1","2"]}');
  });

  it('throws a contextualized error on circular references (engine-native detection)', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj['self'] = obj;
    expect(() => bigintSafeStringify(obj)).toThrow(/[Cc]ircular/);
  });

  it('does NOT throw on shared-reference DAGs (positions[shared, shared])', () => {
    const shared = { ref: 1n };
    expect(bigintSafeStringify({ positions: [shared, shared] })).toBe(
      '{"positions":[{"ref":"1"},{"ref":"1"}]}',
    );
  });

  it('throws on top-level undefined (JSON.stringify(undefined) returns undefined, not "undefined")', () => {
    expect(() => bigintSafeStringify(undefined)).toThrow(/undefined/);
  });

  it('throws on top-level function / Symbol / Promise (same :string contract violation)', () => {
    expect(() => bigintSafeStringify(() => 1)).toThrow(/not serializable/);
    expect(() => bigintSafeStringify(Symbol('x'))).toThrow(/not serializable/);
    expect(() => bigintSafeStringify(Promise.resolve(1))).toThrow(/not serializable/);
  });

  it('throws on NESTED Promise/function/Symbol with key-path attribution', () => {
    expect(() => bigintSafeStringify({ data: Promise.resolve(1) })).toThrow(/nested.*at \.data/);
    expect(() => bigintSafeStringify({ cb: () => 1 })).toThrow(/nested.*at \.cb/);
    expect(() => bigintSafeStringify({ k: Symbol('x') })).toThrow(/nested.*at \.k/);
  });

  it('catches empty-string-key Promise (value-identity check vs root, not key-string)', () => {
    // Previous PR used `key !== ''` to skip the top-level call, which conflated
    // root invocation with literal `''` keys. This payload would silently emit
    // `{"":{}}` under the broken check. Key-path attribution is empty here.
    expect(() => bigintSafeStringify({ '': Promise.resolve(1) })).toThrow(/nested.*at \./);
  });

  it('catches deeply nested non-serializable values (depth 3+) with the leaf key', () => {
    expect(() => bigintSafeStringify({ a: { b: { c: Promise.resolve(1) } } })).toThrow(
      /nested.*at \.c/,
    );
    expect(() => bigintSafeStringify({ a: { b: { c: () => 1 } } })).toThrow(/nested.*at \.c/);
  });

  it('catches a Promise inside an array (numeric-string key path)', () => {
    expect(() => bigintSafeStringify([Promise.resolve(1)])).toThrow(/nested.*at \.0/);
    expect(() => bigintSafeStringify({ positions: [Promise.resolve(1)] })).toThrow(
      /nested.*at \.0/,
    );
  });

  it('throws on nested WeakMap / WeakSet with key-path (would serialize as {} silently)', () => {
    expect(() => bigintSafeStringify({ wm: new WeakMap() })).toThrow(/WeakMap\/WeakSet at \.wm/);
    expect(() => bigintSafeStringify({ ws: new WeakSet() })).toThrow(/WeakMap\/WeakSet at \.ws/);
  });

  it('accepts top-level null (JSON.stringify(null) = "null")', () => {
    expect(bigintSafeStringify(null)).toBe('null');
  });

  it('leaves plain numbers + strings untouched', () => {
    expect(bigintSafeStringify({ n: 42, s: 'hi' })).toBe('{"n":42,"s":"hi"}');
  });

  it('triggers the post-stringify guard when toJSON() returns undefined at the root', () => {
    // The pre-guards reject undefined/function/symbol AT the root, but the
    // ECMA-262 `SerializeJSONProperty` algorithm invokes `toJSON()` on the
    // value BEFORE the replacer runs (step 2 of the algorithm; the
    // version-specific section number is omitted because it has shifted
    // across spec editions — the algorithm name is the durable identifier).
    // A root whose `toJSON` returns undefined passes our pre-guard (it's an
    // object), enters JSON.stringify (which returns the literal `undefined`,
    // not a string), and the post-guard fires. This is the primary
    // documented path that reaches the `typeof result !== 'string'` branch
    // today; sibling cases (toJSON returning function/symbol) reach the
    // same branch via the same upstream cause, exercised below.
    const sneaky = {
      toJSON() {
        return undefined;
      },
    };
    expect(() => bigintSafeStringify(sneaky)).toThrow(
      /JSON\.stringify returned non-string \(undefined\)/,
    );
  });

  it('routes a toJSON()-returned function through the nested replacer guard (NOT the post-guard)', () => {
    // Subtle: `toJSON()` returning a function reaches the REPLACER first,
    // and our nested-data-corruption guard fires before JSON.stringify can
    // collapse the function to `undefined`. Different code path from the
    // toJSON-returns-undefined case (post-stringify guard) because the
    // replacer's `typeof v === 'function'` check intercepts. Documents the
    // routing: function/symbol returned from toJSON → nested guard;
    // undefined returned from toJSON → post-stringify guard.
    const fnRoot = {
      toJSON() {
        return () => 'never serialized';
      },
    };
    expect(() => bigintSafeStringify(fnRoot)).toThrow(/non-serializable nested function/);
  });

  it('routes a toJSON()-returned symbol through the nested replacer guard', () => {
    // Mirror of the function case — same routing, symbol cause.
    const symRoot = {
      toJSON() {
        return Symbol('payload');
      },
    };
    expect(() => bigintSafeStringify(symRoot)).toThrow(/non-serializable nested symbol/);
  });

  it('decorates the error when toJSON() itself throws (cause-rewrap branch)', () => {
    // Different branch: a throwing toJSON propagates synchronously out of
    // JSON.stringify and the cause-rewrap catch decorates it with the
    // `[@concierge/tools]` prefix + the original cause attached. Locks the
    // contract that THIS path stays distinct from the post-stringify guard.
    const throwingRoot = {
      toJSON() {
        throw new Error('toJSON sentinel boom');
      },
    };
    expect(() => bigintSafeStringify(throwingRoot)).toThrow(
      /\[@concierge\/tools\] bigintSafeStringify: toJSON sentinel boom/,
    );
  });
});
