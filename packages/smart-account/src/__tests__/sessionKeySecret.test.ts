import { ConciergeError } from '@concierge/sdk';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SessionKeySecret } from '../crypto/sessionKeySecret.ts';

describe('SessionKeySecret.fromHex', () => {
  it('consume returns 32-byte buffer + flips consumed flag', () => {
    const sk = SessionKeySecret.fromHex(`0x${'aa'.repeat(32)}` as Hex);
    expect(sk.consumed).toBe(false);
    const buf = sk.consume();
    expect(buf).toHaveLength(32);
    expect(buf.equals(Buffer.alloc(32, 0xaa))).toBe(true);
    expect(sk.consumed).toBe(true);
  });

  it('double-consume throws', () => {
    const sk = SessionKeySecret.fromHex(`0x${'aa'.repeat(32)}` as Hex);
    sk.consume();
    expect(() => sk.consume()).toThrow(ConciergeError);
  });

  it('toString + toJSON + util.inspect redact', () => {
    const sk = SessionKeySecret.fromHex(`0x${'aa'.repeat(32)}` as Hex);
    expect(`${sk}`).toBe('[SessionKeySecret REDACTED]');
    expect(JSON.stringify(sk)).toBe('"[SessionKeySecret REDACTED]"');
    // biome-ignore lint/suspicious/noExplicitAny: probing the inspect symbol
    expect((sk as any)[Symbol.for('nodejs.util.inspect.custom')]()).toContain('REDACTED');
  });

  it('rejects malformed hex (length, prefix)', () => {
    expect(() => SessionKeySecret.fromHex('0xshort' as Hex)).toThrow(ConciergeError);
    expect(() => SessionKeySecret.fromHex(`00${'aa'.repeat(32)}` as Hex)).toThrow(ConciergeError);
  });
});

describe('SessionKeySecret.fromBytes', () => {
  it('takes ownership and wipes the caller buffer', () => {
    const input = Buffer.alloc(32, 0xab);
    const sk = SessionKeySecret.fromBytes(input);
    // Caller buffer is wiped (filled with random bytes — almost certainly no longer all 0xab)
    expect(input.equals(Buffer.alloc(32, 0xab))).toBe(false);
    const bytes = sk.consume();
    expect(bytes).toHaveLength(32);
    expect(bytes.equals(Buffer.alloc(32, 0xab))).toBe(true);
  });

  it('rejects non-Buffer / wrong-length input', () => {
    expect(() => SessionKeySecret.fromBytes(Buffer.alloc(16))).toThrow(ConciergeError);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime input guard
    expect(() => SessionKeySecret.fromBytes('not a buffer' as any)).toThrow(ConciergeError);
  });
});

describe('SessionKeySecret.wipeIfUnconsumed', () => {
  it('wipes when fresh', () => {
    const sk = SessionKeySecret.fromHex(`0x${'aa'.repeat(32)}` as Hex);
    sk.wipeIfUnconsumed();
    expect(sk.consumed).toBe(true);
    expect(() => sk.consume()).toThrow(ConciergeError);
  });

  it('is idempotent on already-consumed', () => {
    const sk = SessionKeySecret.fromHex(`0x${'aa'.repeat(32)}` as Hex);
    sk.consume();
    expect(() => sk.wipeIfUnconsumed()).not.toThrow();
  });
});

describe('SessionKeySecret instance is frozen', () => {
  it('Object.freeze prevents post-hoc method replacement', () => {
    const sk = SessionKeySecret.fromHex(`0x${'aa'.repeat(32)}` as Hex);
    expect(Object.isFrozen(sk)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: probing freeze behaviour
    expect(() => ((sk as any).toString = () => 'leaked')).toThrow(TypeError);
  });
});
