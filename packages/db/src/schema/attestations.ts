import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Mirror of on-chain ERC-8004 attestations for fast off-chain queries (reputation
 * timelines, agent reputation scoring without re-reading the registry every tick).
 * Primary key is the on-chain UID — uniqueness guaranteed by the registry contract.
 */
export const attestations = pgTable('attestations', {
  uid: text('uid').primaryKey(),
  schemaUid: text('schema_uid').notNull(),
  /** Agent id (registry-side). NOT a FK because attestations can outlive a local agent record. */
  agentId: text('agent_id').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  txHash: text('tx_hash').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type Attestation = typeof attestations.$inferSelect;
export type NewAttestation = typeof attestations.$inferInsert;
