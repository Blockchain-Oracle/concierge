import { createCipheriv, createDecipheriv, randomBytes, randomFillSync } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';

/**
 * AES-256-GCM envelope: `[12-byte IV][16-byte tag][ciphertext]`. Self-contained;
 * row's bytea column carries everything decryption needs given the key + AAD.
 */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const PLAINTEXT_BYTES = 32; // session-key private key is exactly 32 bytes
export const ENVELOPE_BYTES = IV_BYTES + TAG_BYTES + PLAINTEXT_BYTES; // = 60

/**
 * Assert the encryption key is exactly 32 bytes. Centralized so persist + load
 * (+ any future rotation flow) cannot drift on the validation message or bound.
 */
export function assertEncryptionKey(key: Buffer, caller: string): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] ${caller}: encryptionKey must be exactly ${KEY_BYTES} bytes (AES-256), got ${Buffer.isBuffer(key) ? key.length : typeof key}.`,
    );
  }
}

/**
 * Build the AAD that binds a ciphertext to a specific row identity. A DB-write
 * attacker can swap envelopes between rows; with AAD bound to (agentId,
 * sessionKeyAddress), the swapped envelope's GCM tag verification fails closed.
 * AAD is NOT secret — only its presence + binding matters.
 */
export function envelopeAad(agentId: string, sessionKeyAddress: string): Buffer {
  return Buffer.from(`${agentId}:${sessionKeyAddress.toLowerCase()}`, 'utf8');
}

/**
 * Encrypt 32-byte plaintext into a 60-byte envelope. Caller is responsible for
 * wiping `plaintext` after the call — this function does not own the input.
 *
 * IV is fresh `randomBytes(12)` per encryption. Note: NIST SP 800-38D bounds
 * random 96-bit IVs at ~2^32 encryptions per key before collision probability
 * is unsafe. Callers MUST derive the encryption key per-user (NEVER share a
 * global key across users) and avoid issuance loops that re-encrypt under the
 * same key millions of times.
 */
export function encryptEnvelope(plaintext: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (plaintext.length !== PLAINTEXT_BYTES) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] encryptEnvelope: plaintext must be ${PLAINTEXT_BYTES} bytes, got ${plaintext.length}.`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/**
 * Decrypt a 60-byte envelope back to 32 bytes of plaintext. Throws on any
 * tampering (wrong AAD, wrong key, modified ciphertext, modified IV, modified
 * tag) via AES-256-GCM's authenticated decryption. Errors are intentionally
 * NOT wrapped with the raw Node crypto error as `cause` — that would expose
 * envelope bytes through stack-trace capture in upstream loggers.
 */
export function decryptEnvelope(envelope: Buffer, key: Buffer, aad: Buffer): Buffer {
  // Strict equality on envelope length — anything else is corruption.
  if (envelope.length !== ENVELOPE_BYTES) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] decryptEnvelope: envelope length ${envelope.length} is not the expected ${ENVELOPE_BYTES} bytes (corrupted row or wrong column).`,
    );
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Drop the cause — Node's crypto error stack may capture envelope bytes
    // via locals snapshot. Wipe the AAD reference for good measure.
    randomFillSync(Buffer.from(aad));
    throw new ConciergeError(
      'DecryptionFailed',
      '[@concierge/smart-account] decryptEnvelope: AES-256-GCM decryption failed — wrong encryption key, wrong AAD (agentId/sessionKeyAddress mismatch — possible row swap), tampered ciphertext, or corrupted envelope.',
    );
  }
  if (plaintext.length !== PLAINTEXT_BYTES) {
    randomFillSync(plaintext);
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] decryptEnvelope: decrypted plaintext is not ${PLAINTEXT_BYTES} bytes (got ${plaintext.length}).`,
    );
  }
  return plaintext;
}
