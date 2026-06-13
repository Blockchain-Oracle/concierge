import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import { policyJsonSchema } from './crypto/policyJsonSchema.ts';
import { assertEncryptionKey, decryptEnvelope, envelopeAad } from './crypto/sessionKeyEnvelope.ts';
import { SessionKeySecret } from './crypto/sessionKeySecret.ts';

export interface LoadSessionKeyConfig {
  readonly db: DbClient;
  readonly sessionKeyId: string;
  /**
   * REQUIRED. Without this, loadSessionKey is an IDOR existence-oracle
   * (CWE-639). Checked BEFORE crypto; mismatch raises the SAME `DecryptionFailed`
   * shape as a wrong-key load so an attacker probing IDs cannot distinguish
   * "wrong agent" from "wrong key for right agent" via error type.
   */
  readonly expectedAgentId: string;
  readonly encryptionKey: Buffer;
}

export interface LoadedSessionKey {
  /** Single-use SessionKeySecret. Caller MUST consume() exactly once. */
  readonly privateKey: SessionKeySecret;
  readonly encodedPolicy: Hex;
  readonly enableTypedDataHash: Hex;
  readonly signature: Hex;
  readonly validUntil: Date;
  readonly validAfter: number;
}

/**
 * Reads a row from `session_keys`, checks the kill switches, decrypts.
 *
 * **Authoritative-source-of-truth (round-2):** validUntil + signature live
 * in policyJson AND the table columns. loadSessionKey trusts policyJson
 * (signature-covered) and rejects any drift between the two with
 * `DecryptionFailed`. A DB-write attacker who mutates the column alone fails
 * closed.
 *
 * Distinct typed errors per failure mode (runtime routes them to distinct
 * recovery actions):
 *   - DecryptionFailed        — tampering / wrong key / wrong agent / shape drift
 *   - SessionKeyExpired       — silent re-auth
 *   - SessionKeyRevoked       — silent re-auth + audit
 *   - ConfigError (not-found) — programmer error
 */
export async function loadSessionKey(config: LoadSessionKeyConfig): Promise<LoadedSessionKey> {
  assertEncryptionKey(config.encryptionKey, 'loadSessionKey');
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
  // Agent binding check BEFORE crypto (CWE-639 mitigation).
  if (row.agentId !== config.expectedAgentId) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: row agent binding mismatch for session key '${config.sessionKeyId}'.`,
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
  // Parse policyJson at the DB boundary — schema drift surfaces as DecryptionFailed.
  const parsed = policyJsonSchema.safeParse(row.policyJson);
  if (!parsed.success) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: policy_json shape drift — ${parsed.error.message}`,
    );
  }
  const policy = parsed.data;
  // Cross-check column ↔ policyJson for both validUntil and signature.
  // policyJson is signature-covered (via enableTypedDataHash → signature). If
  // a DB-write attacker mutates only the column, this fires.
  const columnValidUntilSecs = Math.floor(row.validUntil.getTime() / 1000);
  if (columnValidUntilSecs !== policy.validUntil) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: validUntil drift — column=${columnValidUntilSecs}s, policyJson=${policy.validUntil}s. The signature-covered policyJson is authoritative; the column has been mutated.`,
    );
  }
  if (row.signature !== policy.signature) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: signature drift between column and policyJson — possible row tampering.`,
    );
  }
  // Authoritative expiry from policyJson.
  const nowSecs = Math.floor(Date.now() / 1000);
  if (policy.validUntil <= nowSecs) {
    throw new ConciergeError(
      'SessionKeyExpired',
      `[@concierge/smart-account] loadSessionKey: session key expired at ${policy.validUntil} (now=${nowSecs}).`,
      undefined,
      { expiredAt: policy.validUntil },
    );
  }
  if (policy.validAfter > nowSecs) {
    throw new ConciergeError(
      'SessionKeyExpired',
      `[@concierge/smart-account] loadSessionKey: session key is not yet valid (validAfter=${policy.validAfter}, now=${nowSecs}).`,
      undefined,
      { notValidUntil: policy.validAfter },
    );
  }
  const aad = envelopeAad({ agentId: row.agentId, sessionKeyAddress: row.publicAddress });
  // decryptEnvelope returns a freshly-allocated Buffer — fromBytes takes
  // ownership and wipes our local reference. NO hex string is materialized,
  // closing the V8-intern leak that round-1 left open.
  const plaintext = decryptEnvelope(row.encryptedPrivateKey, config.encryptionKey, aad);
  const privateKey = SessionKeySecret.fromBytes(plaintext);
  return {
    privateKey,
    encodedPolicy: policy.encodedPolicy as Hex,
    enableTypedDataHash: policy.enableTypedDataHash as Hex,
    signature: policy.signature as Hex,
    validUntil: row.validUntil,
    validAfter: policy.validAfter,
  };
}
