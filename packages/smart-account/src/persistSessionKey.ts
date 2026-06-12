import { createCipheriv, randomBytes, randomFillSync } from 'node:crypto';
import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import type { IssueSessionKeyResult } from './issueSessionKey.ts';

/**
 * AES-256-GCM ciphertext envelope. Stored verbatim as bytea in the
 * encrypted_private_key column (story-69). Format:
 *   [12-byte IV] [16-byte auth tag] [N bytes ciphertext]
 * Self-contained — no separate IV/tag columns — so a row can be decrypted
 * with just the encryption key + the bytea blob.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const REQUIRED_KEY_BYTES = 32; // AES-256

export interface PersistSessionKeyConfig {
  readonly db: DbClient;
  readonly agentId: string;
  /** The issuance result. After this call, `sessionKey.sessionKeyPrivateKey` is wiped. */
  readonly sessionKey: IssueSessionKeyResult;
  /** Owner-derived per-account 32-byte encryption key (e.g., HKDF from Privy session secret). */
  readonly encryptionKey: Buffer;
  /** Pre-validated agent owner address — stamped on the row for forensic queries. */
  readonly ownerAddress?: Address;
}

export interface PersistSessionKeyResult {
  readonly sessionKeyId: string;
  readonly persistedAt: Date;
}

function pkHexToBuffer(pk: Hex): Buffer {
  return Buffer.from(pk.slice(2), 'hex');
}

/**
 * Encrypts the session-key private key with AES-256-GCM and inserts a row in
 * the `session_keys` table. Wipes the plaintext Buffer before returning.
 *
 * Encryption-at-rest is a non-negotiable (CLAUDE.md no-silent-failures +
 * story-53 acceptance criteria). The caller must:
 *   - supply a 32-byte encryptionKey derived per-user (NEVER reused)
 *   - drop their reference to `sessionKey.sessionKeyPrivateKey` after this call
 */
export async function persistSessionKey(
  config: PersistSessionKeyConfig,
): Promise<PersistSessionKeyResult> {
  if (config.encryptionKey.length !== REQUIRED_KEY_BYTES) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] persistSessionKey: encryptionKey must be exactly ${REQUIRED_KEY_BYTES} bytes (AES-256), got ${config.encryptionKey.length}.`,
    );
  }
  const plaintext = pkHexToBuffer(config.sessionKey.sessionKeyPrivateKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Wipe the plaintext buffer immediately — even though the upstream hex string
  // may linger in V8's literal cache, we destroy the byte-aligned copy that's
  // closest to the memory-dump surface.
  randomFillSync(plaintext);
  const envelope = Buffer.concat([iv, tag, ciphertext]);
  const policyJson = {
    encodedPolicy: config.sessionKey.encodedPolicy,
    signature: config.sessionKey.signature,
    validAfter: config.sessionKey.validAfter,
    ...(config.ownerAddress !== undefined && { ownerAddress: config.ownerAddress }),
  };
  const validUntilDate = new Date(config.sessionKey.validUntil * 1000);
  const inserted = await config.db
    .insert(sessionKeys)
    .values({
      agentId: config.agentId,
      publicAddress: config.sessionKey.sessionKeyAddress,
      encryptedPrivateKey: envelope,
      policyJson,
      signature: config.sessionKey.signature,
      validUntil: validUntilDate,
    })
    .returning({ id: sessionKeys.id, createdAt: sessionKeys.createdAt });
  const row = inserted[0];
  if (!row) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/smart-account] persistSessionKey: insert returned no rows — DB driver invariant broken.',
    );
  }
  return { sessionKeyId: row.id, persistedAt: row.createdAt };
}
