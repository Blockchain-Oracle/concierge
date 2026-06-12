import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import type { Address } from 'viem';
import type { PolicyJson } from './crypto/policyJsonSchema.ts';
import { assertEncryptionKey, encryptEnvelope, envelopeAad } from './crypto/sessionKeyEnvelope.ts';
import type { IssueSessionKeyResult } from './issueSessionKey.ts';

export interface PersistSessionKeyConfig {
  readonly db: DbClient;
  readonly agentId: string;
  /**
   * The issuance result. `sessionKey.sessionKeyPrivateKey.consume()` is called
   * exactly once inside this function — passing the same `sessionKey` to a
   * second persistSessionKey call throws SessionKeySecret-already-consumed.
   */
  readonly sessionKey: IssueSessionKeyResult;
  /**
   * Owner-derived per-account 32-byte AES-256 key. Caller MUST derive this
   * per-user (HKDF from the user's KMS secret) — NEVER share a global key
   * across users. NIST SP 800-38D bounds random 96-bit IVs at ~2^32
   * encryptions per key; per-user derivation keeps us well below that bound.
   */
  readonly encryptionKey: Buffer;
  /** Pre-validated agent owner address — stamped on the row for forensics. */
  readonly ownerAddress?: Address;
}

export interface PersistSessionKeyResult {
  readonly sessionKeyId: string;
  readonly persistedAt: Date;
}

/**
 * Encrypts the session-key private key with AES-256-GCM (AAD-bound to
 * (agentId, sessionKeyAddress)) and inserts a row in `session_keys`. The
 * encryption-key plaintext is wiped through `SessionKeySecret.consume()`
 * post-encryption.
 *
 * **Wipe semantics:** consuming the `SessionKeySecret` zeroes the internal
 * 32-byte buffer that this function passes to the cipher. It does NOT wipe
 * the caller's original `IssueSessionKeyResult.sessionKeyPrivateKey` reference
 * (the handle), but that handle is then permanently consumed — further reads
 * throw. Combined with the handle's redacting `toString`/`toJSON`, the
 * leakable surface is reduced to whatever V8 internals retained a copy of
 * the original `generatePrivateKey()` hex string before it was wrapped — a
 * residual we cannot eliminate from JS.
 */
export async function persistSessionKey(
  config: PersistSessionKeyConfig,
): Promise<PersistSessionKeyResult> {
  assertEncryptionKey(config.encryptionKey, 'persistSessionKey');
  // consume() returns a 32-byte Buffer caller owns; it wipes the handle's internal.
  const plaintext = config.sessionKey.sessionKeyPrivateKey.consume();
  const aad = envelopeAad(config.agentId, config.sessionKey.sessionKeyAddress);
  const envelope = encryptEnvelope(plaintext, config.encryptionKey, aad);
  // Wipe the plaintext we just used; cipher.update has already produced ciphertext.
  plaintext.fill(0);
  const policyJson: PolicyJson = {
    enableTypedDataHash: config.sessionKey.enableTypedDataHash,
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
    // Drizzle's contract is that a successful insert always returns the
    // requested columns. If this fires, the DB driver invariant is broken.
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] persistSessionKey: insert returned no rows — DB driver invariant broken.',
    );
  }
  return { sessionKeyId: row.id, persistedAt: row.createdAt };
}
