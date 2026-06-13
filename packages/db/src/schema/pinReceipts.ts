import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Audit table for IPFS pinning attempts (story-81). Every successful
 * `pinFeedback()` call writes one row regardless of partial failures, so
 * post-hoc queries can answer "did we pin every attested envelope?" +
 * "which service was up when?" + "did CIDs diverge across services?".
 *
 * `cid` is the WINNING CID (primary's if ok, else fallback's). Both
 * `primaryCid` and `fallbackCid` are persisted so divergence is auditable.
 */
export const pinReceipts = pgTable(
  'pin_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cid: text('cid').notNull(),
    /** Agent id (registry-side, decimal uint256 string — matches attestations.agentId). */
    agentId: text('agent_id').notNull(),
    /** bytes32 keccak256 of the canonical envelope content — the on-chain dataHash. */
    hash: text('hash').notNull(),
    cidDivergence: boolean('cid_divergence').notNull().default(false),
    primaryService: text('primary_service').notNull(),
    primaryCid: text('primary_cid'),
    primaryPinId: text('primary_pin_id'),
    primaryOk: boolean('primary_ok').notNull(),
    primaryError: text('primary_error'),
    primaryNotConfigured: boolean('primary_not_configured').notNull().default(false),
    fallbackService: text('fallback_service').notNull(),
    fallbackCid: text('fallback_cid'),
    fallbackPinId: text('fallback_pin_id'),
    fallbackOk: boolean('fallback_ok').notNull(),
    fallbackError: text('fallback_error'),
    fallbackNotConfigured: boolean('fallback_not_configured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    /** CIDv1 base32 lowercase OR CIDv0 base58btc (round-1: tighter than (bafy|Qm).*). */
    cidShape: check(
      'pin_receipts_cid_shape',
      sql`${table.cid} ~ '^bafy[a-z2-7]{52,}$' OR ${table.cid} ~ '^Qm[1-9A-HJ-NP-Za-km-z]{44}$'`,
    ),
    /** agent_id uint256 decimal string. */
    agentIdUint256: check('pin_receipts_agent_id_uint256', sql`${table.agentId} ~ '^[0-9]+$'`),
    /** hash is bytes32 hex. */
    hashBytes32: check('pin_receipts_hash_bytes32', sql`${table.hash} ~ '^0x[0-9a-fA-F]{64}$'`),
    /** At least ONE service must have succeeded — both-fail is the throw path, not a row. */
    atLeastOneOk: check(
      'pin_receipts_at_least_one_ok',
      sql`${table.primaryOk} = true OR ${table.fallbackOk} = true`,
    ),
  }),
);

export type PinReceipt = typeof pinReceipts.$inferSelect;
export type NewPinReceipt = typeof pinReceipts.$inferInsert;
