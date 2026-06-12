import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { ticks } from './ticks.ts';

/** Lifecycle status of a proposal — enforced via pgEnum. */
export const proposalStatusEnum = pgEnum('proposal_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);
export type ProposalStatus = (typeof proposalStatusEnum.enumValues)[number];

/**
 * The propose-phase output. `kind` ('supply', 'borrow', 'swap', 'bridge') +
 * `protocol` ('aave', 'merchant-moe', …) discriminate the planJsonb shape.
 *
 * Unique partial index `(agent_id) WHERE status='pending'` enforces the
 * idempotence guard: a re-tick before the user resolves the prior proposal
 * cannot insert a duplicate (per research/concierge/04-agent-runtime.md § 4).
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    tickId: uuid('tick_id')
      .notNull()
      .references(() => ticks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** USD-denominated trade size, stored as numeric for precision (no float drift). */
    amountUsd: numeric('amount_usd', { precision: 30, scale: 8 }).notNull(),
    protocol: text('protocol').notNull(),
    planJson: jsonb('plan_json').notNull(),
    simJson: jsonb('sim_json').notNull(),
    status: proposalStatusEnum('status').notNull(),
    /** True ⇒ user must click-through; false ⇒ falls under auto-approve threshold. */
    requiresApproval: boolean('requires_approval').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => ({
    /**
     * At most one pending proposal per agent — the propose phase must wait for
     * the user to resolve before generating a new one. Catches the
     * duplicate-proposal regression from a re-tick mid-resolution.
     */
    onePendingPerAgent: uniqueIndex('proposals_one_pending_per_agent')
      .on(table.agentId)
      .where(sql`${table.status} = 'pending'`),
    /**
     * Reject NaN and negative values. Postgres `numeric` ACCEPTS the literal 'NaN'
     * by default — every SUM/aggregation downstream then returns NaN, silently
     * disabling spending-limit comparisons (`NaN > 500` is false). The `x = x`
     * idiom is the canonical NaN-rejecting check in SQL.
     */
    amountUsdNotNan: check(
      'proposals_amount_usd_finite_nonneg',
      sql`${table.amountUsd} = ${table.amountUsd} AND ${table.amountUsd} >= 0`,
    ),
    /** Sanity guard: a proposal must expire after it's created. */
    expiresAfterCreated: check(
      'proposals_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  }),
);

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
