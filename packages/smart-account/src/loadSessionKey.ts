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
   * Expected agent owner — REQUIRED. Without this, loadSessionKey is an IDOR
   * existence-oracle (CWE-639). The function checks `row.agentId === expectedAgentId`
   * BEFORE crypto so a row-binding mismatch fails closed with the same
   * `DecryptionFailed` shape as a wrong-key mismatch — no timing or error-type
   * distinction between "exists but wrong agent" and "wrong key for right row".
   */
  readonly expectedAgentId: string;
  /** Owner-derived per-account 32-byte AES-256 key — same as persist-time. */
  readonly encryptionKey: Buffer;
}

export interface LoadedSessionKey {
  /**
   * Single-use `SessionKeySecret` handle wrapping the decrypted 32-byte
   * private key. Caller MUST `consume()` exactly once and pass the resulting
   * Buffer directly into `privateKeyToAccount` / signer creation. Double-use
   * throws.
   */
  readonly privateKey: SessionKeySecret;
  readonly encodedPolicy: Hex;
  readonly enableTypedDataHash: Hex;
  readonly signature: Hex;
  readonly validUntil: Date;
  readonly validAfter: number;
}

/**
 * Reads a row from `session_keys`, checks the kill switches (revoked,
 * expired, not-yet-valid), and decrypts the private key with the
 * owner-derived encryption key.
 *
 * Distinct typed errors for each failure mode so the runtime can route to
 * the right recovery action:
 *   - `DecryptionFailed`        — suspect tampering / wrong key / wrong agent
 *   - `SessionKeyExpired`       — silent re-auth (UX-positive)
 *   - `SessionKeyRevoked`       — silent re-auth + audit log
 *   - `ConfigError` (not-found) — programmer error; never on hot path
 *
 * Note: existence/state enumeration via timing is mitigated by the required
 * `expectedAgentId` check, which fails closed as `DecryptionFailed` (the same
 * shape an attacker would get for a wrong-key load of a real row).
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
  // Owner binding check BEFORE crypto — prevents cross-tenant decryption attempts
  // and existence-oracle timing distinction. Mismatch raises the SAME error
  // shape a wrong-key load would produce, so an attacker probing IDs cannot
  // distinguish "wrong agent" from "wrong key for right agent".
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
  if (row.validUntil.getTime() <= Date.now()) {
    throw new ConciergeError(
      'SessionKeyExpired',
      `[@concierge/smart-account] loadSessionKey: session key expired at ${row.validUntil.toISOString()}.`,
      undefined,
      { expiredAt: row.validUntil.toISOString() },
    );
  }
  // Parse policy JSON via Zod — schema drift surfaces as a typed error here
  // instead of a TypeError deep in the worker.
  const parsed = policyJsonSchema.safeParse(row.policyJson);
  if (!parsed.success) {
    throw new ConciergeError(
      'DecryptionFailed',
      `[@concierge/smart-account] loadSessionKey: policy_json shape drift — ${parsed.error.message}`,
    );
  }
  const policy = parsed.data;
  // Not-yet-valid kill switch (validAfter is stored in policyJson).
  const nowSecs = Math.floor(Date.now() / 1000);
  if (policy.validAfter > nowSecs) {
    throw new ConciergeError(
      'SessionKeyExpired',
      `[@concierge/smart-account] loadSessionKey: session key is not yet valid (validAfter=${policy.validAfter}, now=${nowSecs}).`,
      undefined,
      { notValidUntil: policy.validAfter },
    );
  }
  // AAD must exactly match the persist-time binding — any drift in
  // (agentId, publicAddress) breaks decryption.
  const aad = envelopeAad(row.agentId, row.publicAddress);
  const plaintext = decryptEnvelope(row.encryptedPrivateKey, config.encryptionKey, aad);
  // Wrap in the redacting handle and wipe the local buffer; the handle now
  // owns the only mutable copy.
  const privateKey = new SessionKeySecret(`0x${plaintext.toString('hex')}` as Hex);
  plaintext.fill(0);
  return {
    privateKey,
    encodedPolicy: policy.encodedPolicy as Hex,
    enableTypedDataHash: policy.enableTypedDataHash as Hex,
    signature: policy.signature as Hex,
    validUntil: row.validUntil,
    validAfter: policy.validAfter,
  };
}
