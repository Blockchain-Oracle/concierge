import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
 * AAD binds a ciphertext to a specific (agentId, sessionKeyAddress) row identity.
 * A DB-write attacker who swaps envelopes between rows hits a GCM tag-verification
 * failure when the AAD at decrypt time doesn't match the encrypt-time AAD.
 *
 * Struct param (not positional) so a future caller cannot accidentally swap
 * `agentId` and `sessionKeyAddress` — both are `string` and the compiler would
 * otherwise be silent on a positional mistake. AAD is NOT secret; only its
 * presence + binding matter.
 */
export interface EnvelopeAadParts {
  readonly agentId: string;
  readonly sessionKeyAddress: string;
}

export function envelopeAad(parts: EnvelopeAadParts): Buffer {
  return Buffer.from(`${parts.agentId}:${parts.sessionKeyAddress.toLowerCase()}`, 'utf8');
}

/**
 * Encrypt 32-byte plaintext into a 60-byte envelope.
 *
 * IV is fresh `randomBytes(12)` per encryption. NIST SP 800-38D bounds random
 * 96-bit IVs at ~2^32 encryptions per key. Callers MUST derive `key` per-user
 * (NEVER share a global key across users) so this bound is unreachable in
 * practice.
 *
 * Caller owns `plaintext` — this function does NOT wipe it. Wrap the call in
 * a try/finally that wipes regardless of throw.
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
 * Decrypt a 60-byte envelope back to 32 bytes of plaintext.
 *
 * AES-256-GCM authenticated decryption: any single-bit tamper of envelope, IV,
 * tag, ciphertext, or AAD causes `final()` to throw. The Node crypto error is
 * intentionally NOT attached as `cause` — its stack frames can capture envelope
 * bytes / key references via locals snapshot in upstream loggers.
 */
export function decryptEnvelope(envelope: Buffer, key: Buffer, aad: Buffer): Buffer {
  if (envelope.length !== ENVELOPE_BYTES) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] decryptEnvelope: envelope length ${envelope.length} is not the expected ${ENVELOPE_BYTES} bytes (corrupted row or wrong column).`,
    );
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new ConciergeError(
      'DecryptionFailed',
      '[@concierge/smart-account] decryptEnvelope: AES-256-GCM decryption failed — wrong encryption key, wrong AAD (agentId/sessionKeyAddress mismatch — possible row swap), tampered ciphertext, or corrupted envelope.',
    );
  }
}
