import { randomFillSync } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Hex } from 'viem';

/**
 * Move-once handle wrapping a 32-byte session-key private key.
 *
 * JS strings are immutable + V8-interned, so a `Hex` private key cannot be
 * wiped. This class holds the bytes in a mutable Buffer behind a redacting
 * surface (toString/toJSON/util.inspect) and a `consume()` that wipes after
 * one use. Double-consume throws.
 *
 * Use `fromHex` ONLY at issuance (viem's `generatePrivateKey()` already
 * returns a hex string we can't avoid). Use `fromBytes` everywhere else
 * (load path) to avoid materializing a fresh interned string.
 */
export class SessionKeySecret {
  #buffer: Buffer | null;
  #consumed = false;

  private constructor(buffer: Buffer) {
    this.#buffer = buffer;
    Object.freeze(this);
  }

  /**
   * Construct from a 0x-prefixed 32-byte hex string. Use ONLY at issuance —
   * the input string itself is unavoidably interned by V8 until GC. The load
   * path should use `fromBytes` to keep the bytes Buffer-only.
   */
  static fromHex(pk: Hex): SessionKeySecret {
    if (!pk.startsWith('0x') || pk.length !== 66) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] SessionKeySecret.fromHex: expected 0x-prefixed 64-char hex (32 bytes), got length ${pk.length}.`,
      );
    }
    const buf = Buffer.from(pk.slice(2), 'hex');
    if (buf.length !== 32) {
      randomFillSync(buf);
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] SessionKeySecret.fromHex: decoded buffer is not 32 bytes (got ${buf.length}).`,
      );
    }
    return new SessionKeySecret(buf);
  }

  /**
   * Construct from a Buffer the caller owns. Takes ownership: wipes the
   * caller's reference after copying the bytes into the handle's private
   * buffer. NO intermediate hex string is created — the only V8 residue is
   * whatever the caller already had.
   */
  static fromBytes(buf: Buffer): SessionKeySecret {
    if (!Buffer.isBuffer(buf) || buf.length !== 32) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] SessionKeySecret.fromBytes: expected 32-byte Buffer, got ${Buffer.isBuffer(buf) ? `${buf.length} bytes` : typeof buf}.`,
      );
    }
    const owned = Buffer.from(buf);
    randomFillSync(buf);
    return new SessionKeySecret(owned);
  }

  /**
   * Hand the caller their own copy of the 32 bytes and immediately wipe the
   * internal buffer. Throws on double-consume.
   */
  consume(): Buffer {
    if (this.#consumed || !this.#buffer) {
      throw new ConciergeError(
        'ConfigError',
        '[@concierge/smart-account] SessionKeySecret: already consumed — secrets are single-use.',
      );
    }
    this.#consumed = true;
    const out = Buffer.from(this.#buffer);
    randomFillSync(this.#buffer);
    this.#buffer = null;
    return out;
  }

  /**
   * If the secret hasn't been consumed, wipe it. Idempotent — safe to call
   * from a try/finally without checking state. Use this on error paths so a
   * thrown error after construction doesn't leave the buffer live in the heap.
   */
  wipeIfUnconsumed(): void {
    if (this.#consumed || !this.#buffer) return;
    this.#consumed = true;
    randomFillSync(this.#buffer);
    this.#buffer = null;
  }

  get consumed(): boolean {
    return this.#consumed;
  }

  toString(): string {
    return '[SessionKeySecret REDACTED]';
  }
  toJSON(): string {
    return '[SessionKeySecret REDACTED]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[SessionKeySecret REDACTED]';
  }
}
