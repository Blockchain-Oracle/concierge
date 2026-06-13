import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Story-84 ipfs_cache: durable cache of IPFS-fetched envelope payloads keyed
 * by CID. Content is immutable (content-addressed) so a 30-day TTL is safe;
 * `lastAccessedAt` is updated on each cache hit to support future LRU eviction.
 *
 * Belongs in Postgres (not Redis) per ADR-009: durable state.
 */
export const ipfsCache = pgTable(
  'ipfs_cache',
  {
    cid: text('cid').primaryKey(),
    /** Raw canonical JSON bytes — the exact preimage of `feedbackHash`. */
    content: text('content').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** CIDv1 base32 OR CIDv0 base58btc — matches pin_receipts shape constraint. */
    cidShape: check(
      'ipfs_cache_cid_shape',
      sql`${table.cid} ~ '^ba[a-z2-7]{56,256}$' OR ${table.cid} ~ '^Qm[1-9A-HJ-NP-Za-km-z]{44}$'`,
    ),
    /** Cap content size to prevent unbounded growth from malformed gateway responses. */
    contentSize: check('ipfs_cache_content_size', sql`length(${table.content}) <= 1048576`),
    lastAccessedIdx: index('idx_ipfs_cache_last_accessed').on(table.lastAccessedAt),
  }),
);

export type IpfsCacheRow = typeof ipfsCache.$inferSelect;
export type NewIpfsCacheRow = typeof ipfsCache.$inferInsert;
