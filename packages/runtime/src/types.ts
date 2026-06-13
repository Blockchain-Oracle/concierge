/** Tick phases per `research/concierge/04-agent-runtime.md` § 2.1. */
export const ORCHESTRATED_PHASES = ['plan', 'simulate', 'propose', 'execute', 'record'] as const;

export type OrchestratedPhase = (typeof ORCHESTRATED_PHASES)[number];

/** Includes the out-of-loop `decide` phase for historical/log fields (AgentState.recentTicks). */
export type TickPhase = OrchestratedPhase | 'decide';

/**
 * Per-phase outcome.
 *   - `continue` — proceed; carries typed next-phase input
 *   - `stop`     — clean early-return (NOOP / awaiting approval / sim NOT OK)
 *   - `error`    — typed failure with cause tag (`thrown` vs `returned`)
 *
 * Phase functions return `{kind: 'error', error: unknown}` (unwidened); the
 * orchestrator's `runPhase` REWRITES it to include the sanitized `Error` +
 * the `cause` tag so consumers reading `TickResult.errored` get a normalized
 * type. The widened error variant below is the post-orchestrator shape.
 */
export type PhaseOutcome<TData> =
  | { kind: 'continue'; data: TData }
  | { kind: 'stop'; reason: string }
  | { kind: 'error'; error: Error; cause: 'thrown' | 'returned' }
  // Phase impls write this; runPhase rewrites to the typed branch above.
  | { kind: 'error'; error: unknown };

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

export interface AgentState {
  readonly agentId: string;
  readonly userId: string;
  readonly chain: 'mantle-mainnet' | 'mantle-sepolia';
  readonly goal: string;
  readonly policyId: string;
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

/** `cause` discriminates programmer bugs (TypeError, ReferenceError) from domain failures. */
export type TickResult =
  | { kind: 'skipped' }
  | { kind: 'aborted'; phase: OrchestratedPhase; reason: 'ttl_exceeded' }
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
  /** Lock TTL (ms). Default 60_000. MUST exceed ABORT_MARGIN_MS (5_000). */
  readonly lockTtlMs?: number;
  /** Sanitizer override. Default scrubs apikey/Bearer/path-segment-keys + recursive cause chain. */
  readonly sanitizeError?: (err: unknown) => Error;
}

/** Lua DEL returns 1 (success) or 0 (nonce mismatch — someone else's lock). */
export type ReleaseOutcome = 'released' | 'not-held' | 'nonce-mismatch';

export interface TickLock {
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<ReleaseOutcome>;
}

export interface TickLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
