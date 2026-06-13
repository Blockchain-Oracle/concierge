import { vi } from 'vitest';
import { tick } from '../../tick.ts';
import type {
  AgentState,
  Attestation,
  Exec,
  ExecuteFn,
  PhaseOutcome,
  Plan,
  PlanFn,
  Proposal,
  ProposeFn,
  RecordFn,
  ReleaseOutcome,
  Sim,
  SimulateFn,
  TickConfig,
  TickLock,
  TickResult,
} from '../../types.ts';

/**
 * In-memory fakes that compose the 5-phase runtime via the real `tick()`
 * orchestrator from story-62. No anvil/postgres/redis containers; the
 * "integration" surface tested here is the PHASE COMPOSITION contract
 * (lock + ordering + abort + error propagation + idempotence signals).
 * Container-backed e2e (anvil fork, drizzle, ioredis) is deferred to a
 * follow-up story with docker-in-docker CI infra.
 */

export interface FakeOutputs {
  readonly executions: Array<{ proposalId: string; attestationUid: string | null }>;
  readonly attestationsAttempted: string[];
  readonly lockHolders: Set<string>;
}

export interface BuildTickArgs {
  readonly agentId?: string;
  readonly planOutcome?: PhaseOutcome<Plan>;
  readonly simOutcome?: PhaseOutcome<Sim>;
  readonly proposeOutcome?: PhaseOutcome<Proposal>;
  readonly executeOutcome?: PhaseOutcome<Exec>;
  readonly recordOutcome?: PhaseOutcome<Attestation>;
  readonly preheldLock?: boolean;
}

export const AGENT_ID = 'agent-e2e';
export const NOW = new Date('2026-06-13T12:00:00Z');

export const STATE: AgentState = {
  agentId: AGENT_ID,
  userId: 'user-e2e',
  chain: 'mantle-sepolia',
  goal: 'idle yield',
  policyId: 'policy-1',
  recentTicks: [],
  openPositions: [],
};

const DEFAULT_PLAN: PhaseOutcome<Plan> = {
  kind: 'continue',
  data: {
    intent: 'rebalance',
    providerCalls: [{ provider: 'aave', action: 'supply', args: { amount: '25' } }],
  },
};
const DEFAULT_SIM: PhaseOutcome<Sim> = {
  kind: 'continue',
  data: {
    ok: true,
    gasEstimateWei: 250_000n,
    expectedValueDeltaUsd: 0.5,
    warnings: [],
  },
};
const DEFAULT_PROPOSAL: PhaseOutcome<Proposal> = {
  kind: 'continue',
  data: {
    id: 'prop-1',
    requiresApproval: false,
    summary: 'supply 25 USDC',
    txParams: [{ to: '0xaave', data: '0xdeadbeef', value: '0' }],
  },
};
const DEFAULT_EXEC: PhaseOutcome<Exec> = {
  kind: 'continue',
  data: {
    txHashes: [`0x${'a'.repeat(64)}`],
    blockNumbers: [123n],
    gasUsed: 200_000n,
  },
};
const DEFAULT_RECORD: PhaseOutcome<Attestation> = {
  kind: 'continue',
  data: {
    attestationUid: `0x${'c'.repeat(64)}`,
    recordedAt: NOW,
  },
};

export function makeFakes(): FakeOutputs {
  return {
    executions: [],
    attestationsAttempted: [],
    lockHolders: new Set<string>(),
  };
}

export function makeLock(fakes: FakeOutputs): TickLock {
  return {
    async acquire(key, _ttl) {
      if (fakes.lockHolders.has(key)) return false;
      fakes.lockHolders.add(key);
      return true;
    },
    async release(key): Promise<ReleaseOutcome> {
      return fakes.lockHolders.delete(key) ? 'released' : 'not-held';
    },
  };
}

/** Deferred promise — production-grade primitive for forcing a real async boundary in tests. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function buildTickConfig(
  args: BuildTickArgs = {},
  fakes: FakeOutputs = makeFakes(),
): { config: TickConfig; fakes: FakeOutputs; run: () => Promise<TickResult> } {
  const agentId = args.agentId ?? AGENT_ID;
  if (args.preheldLock) fakes.lockHolders.add(`lock:agent:${agentId}`);

  const plan: PlanFn = vi.fn().mockResolvedValue(args.planOutcome ?? DEFAULT_PLAN);
  const simulate: SimulateFn = vi.fn().mockResolvedValue(args.simOutcome ?? DEFAULT_SIM);
  const propose: ProposeFn = vi.fn().mockResolvedValue(args.proposeOutcome ?? DEFAULT_PROPOSAL);
  const execute: ExecuteFn = vi.fn().mockImplementation(async (_state, proposal) => {
    const r = args.executeOutcome ?? DEFAULT_EXEC;
    if (r.kind === 'continue') {
      fakes.executions.push({ proposalId: proposal.id, attestationUid: null });
    }
    return r;
  });
  const record: RecordFn = vi.fn().mockImplementation(async () => {
    const r = args.recordOutcome ?? DEFAULT_RECORD;
    // Round-1 fix: record attempt regardless of outcome so failed attest
    // attempts are observable (was previously invisible if record returned
    // an error variant).
    if (r.kind === 'continue') {
      const last = fakes.executions.at(-1);
      if (last !== undefined) last.attestationUid = r.data.attestationUid;
      fakes.attestationsAttempted.push(r.data.attestationUid);
    } else {
      fakes.attestationsAttempted.push('<attempted-and-failed>');
    }
    return r;
  });

  const config: TickConfig = {
    agentId,
    loadState: vi.fn().mockResolvedValue(STATE),
    plan,
    simulate,
    propose,
    execute,
    record,
    lock: makeLock(fakes),
    lockTtlMs: 60_000,
  };
  return { config, fakes, run: () => tick(config) };
}
