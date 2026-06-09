// Direct unit tests for the shared duck-type guards used by createConciergeTools
// and bigintSafeStringify. Each guard has a non-trivial branching surface
// (4 conjunctive checks for isZodSchema, isThenable's then+catch requirement)
// where the parent unit tests only exercise one or two paths.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isThenable, isZodObject, isZodPipe, isZodSchema } from '../guards.ts';

describe('isThenable (tightened then+catch duck-type)', () => {
  it('accepts a native Promise', () => {
    expect(isThenable(Promise.resolve(1))).toBe(true);
  });

  it('rejects a payload-style { then: () => "x" } without catch (LLM tool output)', () => {
    // biome-ignore lint/suspicious/noThenProperty: testing the duck-type guard
    expect(isThenable({ then: () => 'x' })).toBe(false);
  });

  it('rejects { then: "string", catch: "string" } (not functions)', () => {
    // biome-ignore lint/suspicious/noThenProperty: testing the duck-type guard
    expect(isThenable({ then: 'not a fn', catch: 'not a fn' })).toBe(false);
  });

  it('rejects the exact Promises/A+ §1.2 thenable (then function, no catch)', () => {
    // The headline false-positive the tightened check exists to defend against.
    // biome-ignore lint/suspicious/noThenProperty: testing the duck-type guard
    expect(isThenable({ then: () => Promise.resolve(1) })).toBe(false);
    // biome-ignore lint/suspicious/noThenProperty: testing the duck-type guard
    expect(isThenable({ then: () => 'x', catch: 'not a fn' })).toBe(false);
  });

  it('returns false on a throwing then-getter instead of propagating', () => {
    const obj = Object.defineProperty({}, 'then', {
      get() {
        throw new Error('getter boom');
      },
    });
    expect(() => isThenable(obj)).not.toThrow();
    expect(isThenable(obj)).toBe(false);
  });

  it('rejects null, undefined, primitives, function values', () => {
    expect(isThenable(null)).toBe(false);
    expect(isThenable(undefined)).toBe(false);
    expect(isThenable(0)).toBe(false);
    expect(isThenable('')).toBe(false);
    expect(isThenable(() => 1)).toBe(false);
  });
});

describe('isZodSchema (duck-type for monorepo / peer-dep tolerance)', () => {
  it('accepts canonical zod schemas', () => {
    expect(isZodSchema(z.object({ x: z.string() }))).toBe(true);
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(z.array(z.number()))).toBe(true);
    expect(isZodSchema(z.union([z.string(), z.number()]))).toBe(true);
    expect(isZodSchema(z.string().transform((s) => s.length))).toBe(true);
  });

  it('rejects null, undefined, primitives, plain objects', () => {
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
    expect(isZodSchema('object')).toBe(false);
    expect(isZodSchema({})).toBe(false);
    expect(isZodSchema({ type: 'object', properties: {} })).toBe(false);
  });

  it('rejects half-zod imposters (missing _def OR safeParse OR _def.type)', () => {
    expect(isZodSchema({ _def: { type: 'object' } })).toBe(false); // no safeParse
    expect(isZodSchema({ safeParse: () => ({ success: false }) })).toBe(false); // no _def
    expect(isZodSchema({ _def: { type: 42 }, safeParse: () => ({}) })).toBe(false); // _def.type not a string
    expect(isZodSchema({ _def: {}, safeParse: () => ({}) })).toBe(false); // _def has no type
  });
});

describe('isZodObject / isZodPipe (ADR-017 gate)', () => {
  it('isZodObject accepts a z.object', () => {
    expect(isZodObject(z.object({ x: z.string() }))).toBe(true);
  });

  it('isZodObject rejects scalars, arrays, unions, transforms', () => {
    expect(isZodObject(z.string())).toBe(false);
    expect(isZodObject(z.array(z.string()))).toBe(false);
    expect(isZodObject(z.union([z.object({}), z.string()]))).toBe(false);
    expect(isZodObject(z.string().transform((s) => s.length))).toBe(false);
  });

  it('isZodPipe identifies .transform() and .pipe() chains', () => {
    expect(isZodPipe(z.string().transform((s) => s.length))).toBe(true);
    expect(isZodPipe(z.string().pipe(z.string()))).toBe(true);
  });

  it('isZodPipe is false for plain schemas', () => {
    expect(isZodPipe(z.object({}))).toBe(false);
    expect(isZodPipe(z.string())).toBe(false);
  });
});
