import { ConciergeError } from '@concierge/sdk';
import { sanitizeError } from '../sanitize.ts';
import type { AgentState, PhaseOutcome } from '../types.ts';
import { defaultDriftLog, driftPct, eoaFallback, insertOrThrow } from './executeHelpers.ts';
import type { ExecuteOutcome, ExecutionRow } from './executeSchema.ts';

/** Mantle block time ~6s; 30s wait = 5 confirmations of margin (per story spec). */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const GAS_DRIFT_THRESHOLD_PCT = 20;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_REVERT_REASON_LEN = 4096;
/** UserOp hash shape — 0x + 64 hex chars. Rejecting malformed values closes
 * a CWE-117 log-injection vector via executor-supplied hash interpolation. */
const USER_OP_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface ApprovedProposal {
  readonly id: string;
  readonly txParams: ReadonlyArray<{
    readonly to: string;
    readonly data: string;
    readonly value: string;
  }>;
  readonly gasEstimateWei: bigint;
}

/**
 * Result-shape contract returned by the bundler wait. DISCRIMINATED on
 * `success` so `revertReason` is required iff failure (illegal state
 * unrepresentable: a `success:true` receipt cannot carry a revert reason,
 * and a `success:false` receipt MUST carry one).
 */
export type UserOpReceipt =
  | {
      readonly success: true;
      readonly userOpHash: string;
      readonly txHash: string;
      readonly blockNumber: bigint;
      readonly gasUsedActual: bigint;
    }
  | {
      readonly success: false;
      readonly userOpHash: string;
      readonly txHash: string;
      readonly blockNumber: bigint;
      readonly gasUsedActual: bigint;
      readonly revertReason: string;
    };

/**
 * DI'd execution client. Production wires ZeroDev kernel client + Pimlico
 * bundler from @concierge/smart-account; tests stub. Methods MUST throw
 * SessionKeyExpired / SessionKeyPolicyRejected via ConciergeError.type so the
 * orchestrator can distinguish typed failures from infra.
 */
export interface ExecutorClient {
  /** Submit the UserOp; resolve to its hash. THROWS on session-key policy reject. */
  submit(args: {
    readonly agentId: string;
    readonly txParams: ApprovedProposal['txParams'];
    readonly signal: AbortSignal;
  }): Promise<{ readonly userOpHash: string }>;
  /** Wait for the receipt, racing against `signal`. Resolves regardless of success/failure. */
  waitForReceipt(args: {
    readonly userOpHash: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<UserOpReceipt | null>;
}

export interface SessionKeyLoader {
  /** Returns null when the agent has no smart account → EOA fallback path. */
  load(agentId: string): Promise<{ readonly kind: 'present' } | { readonly kind: 'missing' }>;
}

export interface ExecutionRepository {
  insert(row: ExecutionRow): Promise<{ readonly id: string }>;
}

export interface EoaQueueEnqueue {
  enqueue(args: {
    readonly proposalId: string;
    readonly agentId: string;
  }): Promise<{ readonly queueId: string }>;
}

export interface RunExecuteInputs {
  readonly state: AgentState;
  readonly proposal: ApprovedProposal;
}

export interface RunExecuteDeps {
  readonly executor: ExecutorClient;
  readonly sessionKey: SessionKeyLoader;
  readonly repository: ExecutionRepository;
  readonly eoaQueue: EoaQueueEnqueue;
  readonly abortSignal?: AbortSignal;
  readonly waitTimeoutMs?: number;
  readonly logDrift?: (msg: string) => void;
}

const NEVER_ABORT = new AbortController().signal;

function isSessionKeyExpired(err: unknown): boolean {
  return err instanceof ConciergeError && err.type === 'SessionKeyExpired';
}
function isSessionKeyPolicyRejected(err: unknown): boolean {
  return err instanceof ConciergeError && err.type === 'SessionKeyPolicyRejected';
}

/**
 * Submit the proposal's UserOp via session key. Path matrix:
 *   - no session key   → EOA fallback (enqueue + status awaiting_user_signature)
 *   - expired key      → record + status session_key_expired (orchestrator re-auths)
 *   - policy reject    → rethrow (caller surfaces to user; key needs re-issue)
 *   - submit ok + receipt success → status confirmed (+ drift check)
 *   - receipt failure  → status tx_reverted (+ revertReason)
 *   - no receipt       → status timeout (userOpHash preserved for late polling)
 *
 * NO retries inside execute() — per CLAUDE.md no-silent-failures: orchestrator
 * decides whether to re-plan next tick; silent retry could double-execute.
 */
export async function runExecute(
  inputs: RunExecuteInputs,
  deps: RunExecuteDeps,
): Promise<PhaseOutcome<ExecuteOutcome>> {
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const signal = deps.abortSignal ?? NEVER_ABORT;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < MIN_WAIT_TIMEOUT_MS) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runExecute: waitTimeoutMs must be finite and >= ${MIN_WAIT_TIMEOUT_MS}.`,
    );
  }
  if (inputs.proposal.txParams.length === 0) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runExecute: proposal.txParams must be non-empty.`,
    );
  }

  // Stale-state mitigation: caller MUST pass freshly-read state (per spec).
  // We don't re-read here because state IO is the orchestrator's contract.

  let keyStatus: Awaited<ReturnType<SessionKeyLoader['load']>>;
  try {
    keyStatus = await deps.sessionKey.load(inputs.state.agentId);
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute: sessionKey.load failed: ${safe.message}`,
      safe,
    );
  }

  if (keyStatus.kind === 'missing') {
    return await eoaFallback(inputs, deps);
  }

  let userOpHash: string;
  try {
    const submitted = await deps.executor.submit({
      agentId: inputs.state.agentId,
      txParams: inputs.proposal.txParams,
      signal,
    });
    if (!USER_OP_HASH_RE.test(submitted.userOpHash)) {
      // CWE-117 boundary: reject malformed hash before any interpolation.
      throw new ConciergeError(
        'InvariantViolation',
        `[@concierge/runtime] runExecute: executor returned malformed userOpHash.`,
      );
    }
    // Normalize to lowercase so downstream log/DB dedup keys are case-stable.
    userOpHash = submitted.userOpHash.toLowerCase();
  } catch (err) {
    if (err instanceof ConciergeError && err.type === 'InvariantViolation') throw err;
    if (isSessionKeyExpired(err)) {
      const row = await insertOrThrow(deps.repository, {
        proposalId: inputs.proposal.id,
        agentId: inputs.state.agentId,
        status: 'session_key_expired',
      });
      return {
        kind: 'continue',
        data: { status: 'session_key_expired', executionId: row.id },
      };
    }
    if (isSessionKeyPolicyRejected(err)) throw err;
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute: bundler submit failed: ${safe.message}`,
      safe,
    );
  }

  // Abort between submit-resolve and wait-start: UserOp is already on the
  // bundler. Persist a timeout row so late polling can reconcile, AND emit a
  // structured stderr signal so ops sees the orphan-on-bundler event.
  if (signal.aborted) {
    (deps.logDrift ?? defaultDriftLog)(
      `orphan_on_bundler agent=${inputs.state.agentId} userOpHash=${userOpHash}`,
    );
    const row = await insertOrThrow(deps.repository, {
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
      userOpHash,
      status: 'timeout',
    });
    return {
      kind: 'continue',
      data: { status: 'timeout', executionId: row.id, userOpHash },
    };
  }

  let receipt: UserOpReceipt | null;
  try {
    receipt = await deps.executor.waitForReceipt({ userOpHash, timeoutMs: waitTimeoutMs, signal });
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute: waitForReceipt failed (userOpHash=${userOpHash}): ${safe.message}`,
      safe,
    );
  }

  if (receipt === null) {
    const row = await insertOrThrow(deps.repository, {
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
      userOpHash,
      status: 'timeout',
    });
    return {
      kind: 'continue',
      data: { status: 'timeout', executionId: row.id, userOpHash },
    };
  }

  if (!receipt.success) {
    const revertReason = receipt.revertReason.slice(0, MAX_REVERT_REASON_LEN);
    const row = await insertOrThrow(deps.repository, {
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
      userOpHash,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      gasUsedActual: receipt.gasUsedActual,
      status: 'tx_reverted',
      revertReason,
    });
    return {
      kind: 'continue',
      data: {
        status: 'tx_reverted',
        executionId: row.id,
        userOpHash,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        revertReason,
      },
    };
  }

  const drift = driftPct(receipt.gasUsedActual, inputs.proposal.gasEstimateWei);
  if (drift > GAS_DRIFT_THRESHOLD_PCT) {
    // Round-1: default to stderr writer so drift cannot be silently disabled
    // by an unwired logDrift dep (a provider-regression signal must always fire).
    (deps.logDrift ?? defaultDriftLog)(
      `gas_estimate_drift agent=${inputs.state.agentId} userOpHash=${userOpHash} drift=${drift.toFixed(2)}%`,
    );
  }

  const row = await insertOrThrow(deps.repository, {
    proposalId: inputs.proposal.id,
    agentId: inputs.state.agentId,
    userOpHash,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    gasUsedActual: receipt.gasUsedActual,
    status: 'confirmed',
    gasEstimateDriftPct: drift,
  });
  return {
    kind: 'continue',
    data: {
      status: 'confirmed',
      executionId: row.id,
      userOpHash,
      txHash: receipt.txHash,
      blockNumber: receipt.blockNumber,
      gasUsedActual: receipt.gasUsedActual,
      gasEstimateDriftPct: drift,
    },
  };
}
