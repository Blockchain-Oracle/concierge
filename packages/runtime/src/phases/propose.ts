import { ConciergeError } from '@concierge/sdk';
import { sanitizeError } from '../sanitize.ts';
import type { AgentState, PhaseOutcome, Plan } from '../types.ts';
import {
  PROPOSAL_KINDS,
  PROPOSAL_PROTOCOLS,
  type ProposalCreatedEvent,
  type ProposalDecision,
  type ProposalKind,
  type ProposalProtocol,
  proposalCreatedEventSchema,
} from './proposalSchema.ts';
import type { DetailedSim } from './simulate.ts';

const DEFAULT_AUTO_APPROVAL_USD = 50;
const DEFAULT_HF_FLOOR = 1_500_000_000_000_000_000n;
const DEFAULT_HF_BUFFER_BPS = 1000n; // 10% in basis points
const BPS_DENOMINATOR = 10_000n;
const DEFAULT_PROPOSAL_TTL_MS = 60 * 60 * 1000;
const KIND_SET: ReadonlySet<string> = new Set<string>(PROPOSAL_KINDS);
const PROTOCOL_SET: ReadonlySet<string> = new Set<string>(PROPOSAL_PROTOCOLS);

export interface NewProposalRow {
  readonly agentId: string;
  readonly tickId: string;
  readonly kind: ProposalKind;
  readonly protocol: ProposalProtocol;
  readonly amountUsd: number;
  readonly planJson: unknown;
  readonly simJson: unknown;
  readonly requiresApproval: boolean;
  readonly expiresAt: Date;
}

/**
 * DI'd repository — production wires drizzle; tests stub in-memory. Keeps
 * @concierge/runtime free of a hard @concierge/db dependency.
 */
export interface ProposalRepository {
  findPendingByAgent(agentId: string): Promise<{ readonly id: string } | null>;
  insert(row: NewProposalRow): Promise<{ readonly id: string }>;
}

/** DI'd Redis pub. Production wires ioredis.publish; tests stub. */
export interface ProposalPublisher {
  publish(channel: string, payload: string): Promise<void>;
}

export interface ProposalPolicy {
  readonly autoApprovalThresholdUSD?: number;
  readonly hfFloor?: bigint;
  /** Buffer above floor (basis points) within which the proposal still requires approval. */
  readonly hfBufferBps?: bigint;
  readonly proposalTtlMs?: number;
}

export interface RunProposeInputs {
  readonly state: AgentState;
  readonly tickId: string;
  readonly plan: Plan;
  readonly sim: DetailedSim;
  readonly kind: ProposalKind;
  readonly protocol: ProposalProtocol;
  readonly amountUsd: number;
  readonly hypothesis: string;
  /** Optional caller-flagged risk (e.g., warnings.includes('oracle-stale-detected')). */
  readonly riskFlagged?: boolean;
}

export interface RunProposeDeps {
  readonly repository: ProposalRepository;
  readonly publisher: ProposalPublisher;
  readonly now: () => Date;
  readonly policy?: ProposalPolicy;
}

/**
 * Decide whether the proposal requires manual approval. PURE: no IO.
 * Returns true if ANY trigger fires:
 *   - amount over threshold
 *   - projected HF within `hfBufferBps` of floor (near-liquidation)
 *   - caller flagged risk
 */
export function decideRequiresApproval(args: {
  amountUsd: number;
  healthFactorAfter: bigint;
  hfFloor: bigint;
  hfBufferBps: bigint;
  autoApprovalThresholdUSD: number;
  riskFlagged: boolean;
}): boolean {
  if (args.riskFlagged) return true;
  if (args.amountUsd > args.autoApprovalThresholdUSD) return true;
  // hfThreshold = floor * (1 + bufferBps/10000). Use bigint math to avoid drift.
  const hfThreshold = (args.hfFloor * (BPS_DENOMINATOR + args.hfBufferBps)) / BPS_DENOMINATOR;
  return args.healthFactorAfter < hfThreshold;
}

/**
 * Insert a proposals row (or return existing pending). Emits SSE event when
 * a NEW row is inserted; the already-pending branch does NOT re-emit (avoids
 * duplicate cards on re-tick).
 *
 * Domain failures: rejected by repository unique constraint → returned as
 * already_pending. INFRA failures (publisher down, repository throws) →
 * thrown as ConciergeError.
 */
export async function runPropose(
  inputs: RunProposeInputs,
  deps: RunProposeDeps,
): Promise<PhaseOutcome<ProposalDecision>> {
  if (!KIND_SET.has(inputs.kind)) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runPropose: unknown kind '${inputs.kind}'.`,
    );
  }
  if (!PROTOCOL_SET.has(inputs.protocol)) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runPropose: unknown protocol '${inputs.protocol}'.`,
    );
  }
  if (!Number.isFinite(inputs.amountUsd) || inputs.amountUsd < 0) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runPropose: amountUsd must be finite and non-negative.`,
    );
  }

  const policy = deps.policy ?? {};
  const thresholdUSD = policy.autoApprovalThresholdUSD ?? DEFAULT_AUTO_APPROVAL_USD;
  const hfFloor = policy.hfFloor ?? DEFAULT_HF_FLOOR;
  const hfBufferBps = policy.hfBufferBps ?? DEFAULT_HF_BUFFER_BPS;
  const ttlMs = policy.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;

  // Idempotence guard: if a row is already pending, return its id and DO NOT
  // re-emit. The Postgres unique partial index is the source of truth; this
  // pre-check is the polite path that avoids a known constraint violation.
  let existing: { readonly id: string } | null;
  try {
    existing = await deps.repository.findPendingByAgent(inputs.state.agentId);
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runPropose: findPendingByAgent failed: ${sanitizeError(err).message}`,
      sanitizeError(err),
    );
  }
  if (existing !== null) {
    return {
      kind: 'continue',
      data: { kind: 'already_pending', proposalId: existing.id, requiresApproval: true },
    };
  }

  const requiresApproval = decideRequiresApproval({
    amountUsd: inputs.amountUsd,
    healthFactorAfter: inputs.sim.deltaState.healthFactorAfter,
    hfFloor,
    hfBufferBps,
    autoApprovalThresholdUSD: thresholdUSD,
    riskFlagged: inputs.riskFlagged ?? false,
  });

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + ttlMs);

  let inserted: { readonly id: string };
  try {
    inserted = await deps.repository.insert({
      agentId: inputs.state.agentId,
      tickId: inputs.tickId,
      kind: inputs.kind,
      protocol: inputs.protocol,
      amountUsd: inputs.amountUsd,
      planJson: inputs.plan,
      simJson: inputs.sim,
      requiresApproval,
      expiresAt,
    });
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runPropose: insert failed: ${sanitizeError(err).message}`,
      sanitizeError(err),
    );
  }

  const event: ProposalCreatedEvent = {
    type: 'proposal.created',
    proposalId: inserted.id,
    agentId: inputs.state.agentId,
    kind: inputs.kind,
    protocol: inputs.protocol,
    amountUsd: inputs.amountUsd,
    projectedHfBefore: inputs.sim.deltaState.healthFactorBefore.toString(),
    projectedHfAfter: inputs.sim.deltaState.healthFactorAfter.toString(),
    requiresApproval,
    hypothesis: inputs.hypothesis.slice(0, 2000),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  // Sanity-check event shape before publish — surfacing a malformed payload
  // here is preferable to silently sending garbage to the browser.
  const parsed = proposalCreatedEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runPropose: malformed event payload: ${parsed.error.message}`,
    );
  }

  const channel = `user:${inputs.state.userId}:proposals`;
  try {
    await deps.publisher.publish(channel, JSON.stringify(parsed.data));
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runPropose: publish failed: ${sanitizeError(err).message}`,
      sanitizeError(err),
    );
  }

  return {
    kind: 'continue',
    data: { kind: 'created', proposalId: inserted.id, requiresApproval },
  };
}
