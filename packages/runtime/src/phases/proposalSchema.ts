import { z } from 'zod';

export const PROPOSAL_KINDS = ['supply', 'borrow', 'swap', 'bridge'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_PROTOCOLS = [
  'aave',
  'merchant-moe',
  'agni',
  'fusionx',
  'ethena',
  'ondo',
  'meth-staking',
  'lifi',
] as const;
export type ProposalProtocol = (typeof PROPOSAL_PROTOCOLS)[number];

export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * SSE event payload published on `user:${userId}:proposals` when a new
 * proposal is created. Web app's SSE handler subscribes and pushes to the
 * connected browser. Keep field set minimal — full proposal is fetched from
 * the API by id when the user opens the card.
 */
// Zod v4 `.uuid()` is version-strict; Postgres `uuid` column is the actual
// gate. Use `.min(1)` here so v7/v8 UUIDs round-trip without re-tightening.
export const proposalCreatedEventSchema = z.object({
  type: z.literal('proposal.created'),
  proposalId: z.string().min(1),
  agentId: z.string().min(1),
  kind: z.enum(PROPOSAL_KINDS),
  protocol: z.enum(PROPOSAL_PROTOCOLS),
  amountUsd: z.number().finite().nonnegative(),
  projectedHfBefore: z.string(),
  projectedHfAfter: z.string(),
  requiresApproval: z.boolean(),
  hypothesis: z.string().max(2000),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type ProposalCreatedEvent = z.infer<typeof proposalCreatedEventSchema>;

/**
 * Discriminated union — `created` carries the truthful `requiresApproval`
 * (computed THIS tick); `already_pending` deliberately does NOT carry the
 * stored row's flag because the propose phase has not re-read it. Consumers
 * fetch the full proposal by id (per the SSE comment above).
 */
export const PROPOSAL_DECISION_KINDS = ['created', 'already_pending'] as const;
export type ProposalDecisionKind = (typeof PROPOSAL_DECISION_KINDS)[number];

export const proposalDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('created'),
    proposalId: z.string().min(1),
    requiresApproval: z.boolean(),
  }),
  z.object({
    kind: z.literal('already_pending'),
    proposalId: z.string().min(1),
  }),
]);
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;
