import { createDecipheriv } from 'node:crypto';
import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const REQUIRED_KEY_BYTES = 32;

export interface LoadSessionKeyConfig {
  readonly db: DbClient;
  readonly sessionKeyId: string;
  /** Owner-derived per-account 32-byte encryption key — same one used at persist time. */
  readonly encryptionKey: Buffer;
}

export interface LoadedSessionKey {
  readonly privateKey: Hex;
  readonly encodedPolicy: Hex;
  readonly signature: Hex;
  readonly validUntil: Date;
}

/**
 * Reads a row from `session_keys`, checks the kill switches (revoked,
 * expired), decrypts the private key with the owner-derived encryption key.
 *
 * Each failure mode throws a DISTINCT typed error so the runtime can map them
 * to the right recovery action:
 *   - `DecryptionFailed`        ⇒ suspect tampering; escalate / re-issue
 *   - `SessionKeyExpired`       ⇒ silent re-auth (UX-positive)
 *   - `SessionKeyRevoked`       ⇒ silent re-auth + audit log entry
 *   - `ConfigError` (not-found) ⇒ programmer error; never on hot path
 */
export async function loadSessionKey(config: LoadSessionKeyConfig): Promise<LoadedSessionKey> {
  if (config.encryptionKey.length !== REQUIRED_KEY_BYTES) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] loadSessionKey: encryptionKey must be exactly ${REQUIRED_KEY_BYTES} bytes (AES-256), got ${config.encryptionKey.length}.`,
    );
  }
  const rows = await config.db
    .select()
    .from(sessionKeys)
    .where(eq(sessionKeys.id, config.sessionKeyId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] loadSessionKey: session key '${config.sessionKeyId}' not found.`,
    );
  }
  if (row.revokedAt !== null) {
    throw new ConciergeError(
      'SessionKeyRevoked',
      `[@concierge/smart-account] loadSessionKey: session key was revoked at ${row.revokedAt.toISOString()}.`,
      undefined,
      { revokedAt: row.revokedAt.toISOString() },
    );
  }
  if (row.validUntil.getTime() <= Date.now()) {
    throw new ConciergeError(
      'SessionKeyExpired',
      `[@concierge/smart-account] loadSessionKey: session key expired at ${row.validUntil.toISOString()}.`,
      undefined,
      { expiredAt: row.validUntil.toISOString() },
    );
  }
  const envelope = row.encryptedPrivateKey;
  if (envelope.length < IV_BYTES + TAG_BYTES + 1) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: encrypted_private_key envelope is malformed (length ${envelope.length}, minimum ${IV_BYTES + TAG_BYTES + 1}).`,
    );
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = envelope.subarray(IV_BYTES + TAG_BYTES);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new ConciergeError(
      'DecryptionFailed',
      '[@concierge/smart-account] loadSessionKey: AES-256-GCM decryption failed — wrong encryption key, tampered ciphertext, or corrupted envelope.',
      err,
    );
  }
  if (plaintext.length !== 32) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: decrypted plaintext is not a 32-byte private key (got ${plaintext.length} bytes).`,
    );
  }
  const privateKey = `0x${plaintext.toString('hex')}` as Hex;
  // biome-ignore lint/suspicious/noExplicitAny: policyJson stored as jsonb; cast at boundary
  const policy = row.policyJson as any;
  return {
    privateKey,
    encodedPolicy: policy.encodedPolicy as Hex,
    signature: policy.signature as Hex,
    validUntil: row.validUntil,
  };
}
