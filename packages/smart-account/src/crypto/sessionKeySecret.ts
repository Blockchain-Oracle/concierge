import { randomFillSync } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Hex } from 'viem';

/**
 * Move-once handle wrapping a 32-byte session-key private key. Designed for the
 * fundamental JS-string immutability problem: `generatePrivateKey()` returns a
 * Hex string that V8 may intern, and `randomFillSync` cannot touch it. Holding
 * the bytes in a mutable Buffer behind a class with redacting `toString`/`toJSON`
 * gives us:
 *
 * 1. **Single use** — `consume()` zeroes the internal buffer and flips a flag;
 *    a double-consume throws. Prevents accidental double-persist or stale-key
 *    reuse by the worker.
 * 2. **Log safety** — `toString`/`toJSON` redact, so `JSON.stringify(result)`,
 *    `console.log(err)`, and Sentry breadcrumbs cannot leak the bytes even if
 *    the Result accidentally lands in an error capture frame.
 * 3. **Wipe semantics that actually work** — the bytes live in a `Buffer` (the
 *    class's own private field), not an immutable string. `randomFillSync` on
 *    `consume()` is a real wipe, not the security-theater wipe of a hex copy.
 *
 * Tradeoff: the caller can no longer trivially do `result.sessionKeyPrivateKey`
 * and pass it to viem's `privateKeyToAccount`. They must `consume()` first;
 * that's an intentional friction surface so security-sensitive code paths
 * are visible at every call site.
 */
export class SessionKeySecret {
  // Use a #private field so even `as any` casts can't reach in from outside.
  // The buffer is owned exclusively by this instance until consumed.
  #buffer: Buffer | null;
  #consumed = false;

  constructor(pk: Hex) {
    if (!pk.startsWith('0x') || pk.length !== 66) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] SessionKeySecret: expected 0x-prefixed 64-char hex (32 bytes), got length ${pk.length}.`,
      );
    }
    this.#buffer = Buffer.from(pk.slice(2), 'hex');
    if (this.#buffer.length !== 32) {
      randomFillSync(this.#buffer);
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] SessionKeySecret: decoded buffer is not 32 bytes (got ${this.#buffer.length}).`,
      );
    }
  }

  /**
   * Hand the caller their own copy of the 32 bytes and immediately wipe the
   * internal buffer. Throws on double-consume to surface accidental reuse.
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

  get consumed(): boolean {
    return this.#consumed;
  }

  // Log-safety surface. Any tool that serializes this object (console.log,
  // JSON.stringify, pino, Sentry, error.cause capture) gets the redacted form.
  toString(): string {
    return '[SessionKeySecret REDACTED]';
  }
  toJSON(): string {
    return '[SessionKeySecret REDACTED]';
  }
  // util.inspect override for Node's console.log
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[SessionKeySecret REDACTED]';
  }
}
