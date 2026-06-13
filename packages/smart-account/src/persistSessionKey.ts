import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import type { Address } from 'viem';
import type { PolicyJson } from './crypto/policyJsonSchema.ts';
import { assertEncryptionKey, encryptEnvelope, envelopeAad } from './crypto/sessionKeyEnvelope.ts';
import type { IssueSessionKeyResult } from './issueSessionKey.ts';

export interface PersistSessionKeyConfig {
  readonly db: DbClient;
  readonly agentId: string;
  readonly sessionKey: IssueSessionKeyResult;
  /**
   * Owner-derived per-account 32-byte AES-256 key. Caller MUST derive this
   * per-user (HKDF from the user's KMS secret) — NEVER share a global key
   * across users.
   */
  readonly encryptionKey: Buffer;
  readonly ownerAddress?: Address;
}

export interface PersistSessionKeyResult {
  readonly sessionKeyId: string;
  readonly persistedAt: Date;
}

/**
 * Encrypts the session-key private key with AES-256-GCM (AAD-bound to
 * (agentId, sessionKeyAddress)) and inserts a row in `session_keys`.
 *
 * **Wipe semantics (round-2):** plaintext is wiped in a `finally` block so a
 * throw from `encryptEnvelope` or the DB insert never leaves live key bytes
 * in the heap.
 *
 * **validUntil is stored INSIDE policyJson** (round-2 fix) so the EIP-712
 * signature's commitment to the policy ends up covering it. The
 * `session_keys.validUntil` column is a query/index helper that loadSessionKey
 * cross-checks against `policy.validUntil` — a DB-write attacker who mutates
 * the column alone fails the cross-check.
 */
export async function persistSessionKey(
  config: PersistSessionKeyConfig,
): Promise<PersistSessionKeyResult> {
  assertEncryptionKey(config.encryptionKey, 'persistSessionKey');
  const plaintext = config.sessionKey.sessionKeyPrivateKey.consume();
  let envelope: Buffer;
  try {
    const aad = envelopeAad({
      agentId: config.agentId,
      sessionKeyAddress: config.sessionKey.sessionKeyAddress,
    });
    envelope = encryptEnvelope(plaintext, config.encryptionKey, aad);
  } finally {
    plaintext.fill(0);
  }
  const policyJson: PolicyJson = {
    enableTypedDataHash: config.sessionKey.enableTypedDataHash,
    encodedPolicy: config.sessionKey.encodedPolicy,
    signature: config.sessionKey.signature,
    validAfter: config.sessionKey.validAfter,
    validUntil: config.sessionKey.validUntil,
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
      'ConfigError',
      '[@concierge/smart-account] persistSessionKey: insert returned no rows — DB driver invariant broken.',
    );
  }
  return { sessionKeyId: row.id, persistedAt: row.createdAt };
}
