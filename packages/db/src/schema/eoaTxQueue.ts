import { sql } from 'drizzle-orm';
import { bigint, check, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';

/** Lifecycle status of an EOA-fallback queued transaction — enforced via pgEnum. */
export const eoaTxStatusEnum = pgEnum('eoa_tx_status', [
  'pending',
  'signed',
  'confirmed',
  'failed',
]);
export type EoaTxStatus = (typeof eoaTxStatusEnum.enumValues)[number];

/**
 * EOA-fallback queue (per ADR-010): if the ERC-4337 path fails on Day 1 the
 * agent enqueues an unsigned tx here for the user to sign client-side later.
 * Loses the autopilot UX but the tick loop survives.
 */
export const eoaTxQueue = pgTable(
  'eoa_tx_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    to: text('to').notNull(),
    data: text('data').notNull(),
    /** wei, stored as text — bigint would overflow JS Number on display; numeric is wasteful. */
    value: text('value').notNull(),
    status: eoaTxStatusEnum('status').notNull(),
    signedTx: text('signed_tx'),
    txHash: text('tx_hash'),
    blockNumber: bigint('block_number', { mode: 'bigint' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    /**
     * value is unsigned-decimal-string wei (max uint256 = 78 digits). Without this
     * check, the signing worker could pull '1.5' / 'abc' / '-100' and either
     * throw deep in viem with no row context or — worse — broadcast a wrong-value tx.
     */
    valueIsUint256: check(
      'eoa_tx_queue_value_uint256',
      sql`${table.value} ~ '^[0-9]+$' AND length(${table.value}) <= 78`,
    ),
    /** Sanity: tx target must look like an address (20-byte hex). */
    toIsAddress: check('eoa_tx_queue_to_is_address', sql`${table.to} ~ '^0x[0-9a-fA-F]{40}$'`),
    /** Sanity: calldata must be 0x-prefixed hex (length parity not enforced — viem checks). */
    dataIsHex: check('eoa_tx_queue_data_is_hex', sql`${table.data} ~ '^0x[0-9a-fA-F]*$'`),
  }),
);

export type EoaTx = typeof eoaTxQueue.$inferSelect;
export type NewEoaTx = typeof eoaTxQueue.$inferInsert;
