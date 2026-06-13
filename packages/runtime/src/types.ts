/**
 * Tick phases per `research/concierge/04-agent-runtime.md` § 2.1.
 *
 * The 5 in-loop phases the orchestrator drives sequentially. `decide` is
 * out-of-loop (governance moment; runs on `proposal.requiresApproval`) so it
 * lives in the broader `TickPhase` union but NOT in `OrchestratedPhase`.
 */
export const ORCHESTRATED_PHASES = ['plan', 'simulate', 'propose', 'execute', 'record'] as const;

export type OrchestratedPhase = (typeof ORCHESTRATED_PHASES)[number];

/** Includes the out-of-loop `decide` phase for historical/log fields. */
export type TickPhase = OrchestratedPhase | 'decide';

export const TICK_PHASES: readonly TickPhase[] = Object.freeze([...ORCHESTRATED_PHASES, 'decide']);

/**
 * Per-phase result discriminator. Three shapes:
 *   - `continue` — proceed to next phase, carrying typed `data`
 *   - `stop`     — clean early-return (NOOP / awaiting approval / sim NOT OK)
 *   - `error`    — typed failure; tick aborts + logs + releases lock
 *
 * `error.error: unknown` at this boundary because phase impls may rethrow
 * arbitrary values. The PUBLIC `TickResult.errored.error` is normalised to
 * `Error` so consumers don't need defensive `instanceof` ladders.
 */
export type PhaseOutcome<TData> =
  | { kind: 'continue'; data: TData }
  | { kind: 'stop'; reason: string }
  | { kind: 'error'; error: unknown };

/**
 * Per-phase function signatures — named aliases so the chain is type-checked
 * at the DI boundary (Plan flows into Simulate's arg, etc.). A generic
 * `PhaseFn<TIn, TOut>` would erase the chain at the lowest-common-denominator
 * shape; the named aliases pull their weight.
 *
 * Each phase function receives an `AbortSignal` so it can cancel cleanly when
 * the lock TTL is approaching (`tick` sets the signal at `lockTtlMs - 5s`).
 */
export type PlanFn = (state: AgentState, signal: AbortSignal) => Promise<PhaseOutcome<Plan>>;
export type SimulateFn = (
  state: AgentState,
  plan: Plan,
  signal: AbortSignal,
) => Promise<PhaseOutcome<Sim>>;
export type ProposeFn = (
  state: AgentState,
  sim: Sim,
  signal: AbortSignal,
) => Promise<PhaseOutcome<Proposal>>;
export type ExecuteFn = (
  state: AgentState,
  proposal: Proposal,
  signal: AbortSignal,
) => Promise<PhaseOutcome<Exec>>;
export type RecordFn = (
  state: AgentState,
  exec: Exec,
  signal: AbortSignal,
) => Promise<PhaseOutcome<Attestation>>;

/**
 * Agent state loaded once per tick. Deep-readonly so a phase that mutates
 * the snapshot is a compile error — phases that need to mutate WRITE to the
 * DB; next tick re-loads.
 */
export interface AgentState {
  readonly agentId: string;
  readonly userId: string;
  readonly chain: 'mantle-mainnet' | 'mantle-sepolia';
  readonly goal: string;
  readonly policyId: string;
  /** Last 5 ticks for short-term context. Newest first. `phase` is the full TickPhase set. */
  readonly recentTicks: readonly { tickId: string; phase: TickPhase; ts: Date }[];
  readonly openPositions: readonly { protocol: string; identifier: string }[];
}

export interface Plan {
  readonly intent: string;
  readonly providerCalls: readonly { provider: string; action: string; args: unknown }[];
}

export interface Sim {
  readonly ok: boolean;
  readonly gasEstimateWei: bigint;
  readonly expectedValueDeltaUsd: number;
  readonly warnings: readonly string[];
}

export interface Proposal {
  readonly id: string;
  readonly requiresApproval: boolean;
  readonly summary: string;
  readonly txParams: readonly { to: string; data: string; value: string }[];
}

export interface Exec {
  readonly txHashes: readonly string[];
  readonly blockNumbers: readonly bigint[];
}

export interface Attestation {
  readonly attestationUid: string;
  readonly recordedAt: Date;
}

/**
 * Final tick outcome. `cause: 'thrown' | 'returned'` on `errored` distinguishes
 * a phase function that THREW (likely programmer bug — TypeError/ReferenceError)
 * from one that returned a typed `{kind:'error'}` (legitimate domain failure).
 * Operators dashboard the two separately.
 */
export type TickResult =
  | { kind: 'skipped' }
  | { kind: 'stopped'; phase: OrchestratedPhase; reason: string }
  | { kind: 'errored'; phase: OrchestratedPhase; error: Error; cause: 'thrown' | 'returned' }
  | { kind: 'completed'; attestation: Attestation };

export interface TickConfig {
  readonly agentId: string;
  readonly loadState: (agentId: string) => Promise<AgentState>;
  readonly plan: PlanFn;
  readonly simulate: SimulateFn;
  readonly propose: ProposeFn;
  readonly execute: ExecuteFn;
  readonly record: RecordFn;
  readonly lock: TickLock;
  readonly logger?: TickLogger;
  /** Lock TTL (ms). Default 60_000. Per-phase AbortSignal fires at TTL - 5s. */
  readonly lockTtlMs?: number;
  /**
   * Sanitizer for error messages before they land in logs / TickResult.
   * Default redacts `apikey=`/`key=`/`token=`/`secret=` URL params (Pimlico
   * shape — see story-55). Caller can override for stricter rules.
   */
  readonly sanitizeError?: (err: unknown) => Error;
}

export interface TickLock {
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface TickLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
