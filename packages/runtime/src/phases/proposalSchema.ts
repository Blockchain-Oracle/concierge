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

/** A row already pending for this agent — propose() returns existing id, no insert. */
export const PROPOSAL_DECISION_KINDS = ['created', 'already_pending'] as const;
export type ProposalDecisionKind = (typeof PROPOSAL_DECISION_KINDS)[number];

export const proposalDecisionSchema = z.object({
  kind: z.enum(PROPOSAL_DECISION_KINDS),
  proposalId: z.string().min(1),
  requiresApproval: z.boolean(),
});
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;
