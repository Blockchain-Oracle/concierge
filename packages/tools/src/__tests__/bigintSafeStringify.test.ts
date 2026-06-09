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
    // The pre-guards reject undefined/function/symbol AT the root, but
    // JSON.stringify's spec calls `toJSON()` on the value BEFORE the
    // replacer runs (ECMA-262 §25.5.2 SerializeJSONProperty step 2). A root
    // whose `toJSON` returns undefined passes our pre-guard (it's an
    // object), enters JSON.stringify (which returns the literal `undefined`,
    // not a string), and the post-guard fires. This is the ONLY currently
    // documented path that reaches the `typeof result !== 'string'` branch.
    const sneaky = {
      toJSON() {
        return undefined;
      },
    };
    expect(() => bigintSafeStringify(sneaky)).toThrow(
      /JSON\.stringify returned non-string \(undefined\)/,
    );
  });
});
