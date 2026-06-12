import { ConciergeError } from '@concierge/sdk';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SessionKeySecret } from '../crypto/sessionKeySecret.ts';

describe('SessionKeySecret', () => {
  it('consume returns 32-byte buffer + flips consumed flag', () => {
    const sk = new SessionKeySecret(`0x${'aa'.repeat(32)}` as Hex);
    expect(sk.consumed).toBe(false);
    const buf = sk.consume();
    expect(buf).toHaveLength(32);
    expect(buf.equals(Buffer.alloc(32, 0xaa))).toBe(true);
    expect(sk.consumed).toBe(true);
  });

  it('double-consume throws', () => {
    const sk = new SessionKeySecret(`0x${'aa'.repeat(32)}` as Hex);
    sk.consume();
    expect(() => sk.consume()).toThrow(ConciergeError);
  });

  it('toString + toJSON + util.inspect redact', () => {
    const sk = new SessionKeySecret(`0x${'aa'.repeat(32)}` as Hex);
    expect(`${sk}`).toBe('[SessionKeySecret REDACTED]');
    expect(JSON.stringify(sk)).toBe('"[SessionKeySecret REDACTED]"');
    // biome-ignore lint/suspicious/noExplicitAny: probing the inspect symbol
    expect((sk as any)[Symbol.for('nodejs.util.inspect.custom')]()).toContain('REDACTED');
  });

  it('rejects malformed hex (length, prefix)', () => {
    expect(() => new SessionKeySecret('0xshort' as Hex)).toThrow(ConciergeError);
    expect(() => new SessionKeySecret(`00${'aa'.repeat(32)}` as Hex)).toThrow(ConciergeError);
  });
});
