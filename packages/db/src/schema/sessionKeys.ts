import { customType, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';

/**
 * BYTEA column — Drizzle's stock `text()` would silently encode the AES blob
 * via the connection's client encoding and corrupt it on retrieval. Per
 * CLAUDE.md no-silent-failures.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Issued session keys — the per-tick credential the agent uses to sign UserOps
 * within the policy bundle composed in story-52. `encryptedPrivateKey` is the
 * KMS-wrapped secret (NEVER stored as plaintext, NEVER as text — bytea forces
 * byte fidelity). `signature` is the user's EOA approval over the policy bundle.
 */
export const sessionKeys = pgTable('session_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  publicAddress: text('public_address').notNull(),
  encryptedPrivateKey: bytea('encrypted_private_key').notNull(),
  policyJson: jsonb('policy_json').notNull(),
  signature: text('signature').notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type SessionKey = typeof sessionKeys.$inferSelect;
export type NewSessionKey = typeof sessionKeys.$inferInsert;
