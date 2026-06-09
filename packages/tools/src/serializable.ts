// Canonical card schemas — MCP `structuredContent` and React Card components
// parse-then-render against these. Tools whose job is to emit one of these
// SHOULD use the schema as their `outputSchema` so the round-trip is type-safe.

import { z } from 'zod';
import type { TickPhase, UICardId } from './types.ts';

// `{ offset: true }` accepts `2026-06-09T00:00:00+00:00` (Postgres timestamptz,
// indexer outputs, AI date strings). zod 4 default rejects offset suffixes.
const IsoDateTime = z.iso.datetime({ offset: true });

export const SerializableProposalCardSchema = z.object({
  id: z.string().regex(/^p_/),
  actionSummary: z.string().min(1),
  estimatedAprDelta: z.number(),
  expectedHealthFactor: z.number().optional(),
  expiresAt: IsoDateTime,
  txPreview: z
    .object({
      to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      value: z.string(),
      data: z.string().regex(/^0x[a-fA-F0-9]*$/),
    })
    .optional(),
});
export type SerializableProposalCard = z.infer<typeof SerializableProposalCardSchema>;
export function safeParseSerializableProposalCard(
  data: unknown,
): z.ZodSafeParseResult<SerializableProposalCard> {
  return SerializableProposalCardSchema.safeParse(data);
}

// Drift in @concierge/shared's TickLoopPhase fails compilation BIDIRECTIONALLY:
// `satisfies` catches narrowing; the `_AssertNever` helper catches widening
// (the previous `_widenFence: ... = null as never` form was a NO-OP — `never`
// is assignable to any type, so widening slipped through silently).
export const TICK_PHASE_VALUES = [
  'plan',
  'simulate',
  'propose',
  'execute',
  'record',
] as const satisfies readonly TickPhase[];
type _AssertNever<T extends never> = T;
type _NoWiden = _AssertNever<Exclude<TickPhase, (typeof TICK_PHASE_VALUES)[number]>>;
type _Used = _NoWiden;

export const SerializableTickCardSchema = z.object({
  tickId: z.string().regex(/^t_/),
  agentId: z.string().min(1),
  phase: z.enum(TICK_PHASE_VALUES),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
  outcome: z.enum(['success', 'failure', 'skipped', 'pending']),
  summary: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type SerializableTickCard = z.infer<typeof SerializableTickCardSchema>;
export function safeParseSerializableTickCard(
  data: unknown,
): z.ZodSafeParseResult<SerializableTickCard> {
  return SerializableTickCardSchema.safeParse(data);
}

const PositionSchema = z.object({
  provider: z.string().min(1),
  symbol: z.string().min(1),
  amount: z.string(),
  usdValue: z.number().optional(),
  apr: z.number().optional(),
});

export const SerializablePortfolioCardSchema = z.object({
  agentId: z.string().min(1),
  totalUsdValue: z.number(),
  positions: z.array(PositionSchema),
  healthFactor: z.number().optional(),
  asOf: IsoDateTime,
});
export type SerializablePortfolioCard = z.infer<typeof SerializablePortfolioCardSchema>;
export function safeParseSerializablePortfolioCard(
  data: unknown,
): z.ZodSafeParseResult<SerializablePortfolioCard> {
  return SerializablePortfolioCardSchema.safeParse(data);
}

export const SerializableReputationCardSchema = z.object({
  agentId: z.string().min(1),
  aggregateScore: z.number(),
  attestationCount: z.number().int().nonnegative(),
  recentAttestations: z
    .array(
      z.object({
        txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
        value: z.number(),
        tag: z.string().optional(),
        attestedAt: IsoDateTime,
      }),
    )
    .max(50),
  registryAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});
export type SerializableReputationCard = z.infer<typeof SerializableReputationCardSchema>;
export function safeParseSerializableReputationCard(
  data: unknown,
): z.ZodSafeParseResult<SerializableReputationCard> {
  return SerializableReputationCardSchema.safeParse(data);
}

/**
 * Compile-time map UICardId → schema. Adding a card id to UICardId without a
 * backing schema fails this `satisfies` check — prevents drift between the
 * type union and the parse-then-render contract.
 */
export const CARD_SCHEMAS = {
  proposal: SerializableProposalCardSchema,
  tick: SerializableTickCardSchema,
  portfolio: SerializablePortfolioCardSchema,
  reputation: SerializableReputationCardSchema,
} as const satisfies Record<UICardId, z.ZodTypeAny>;
