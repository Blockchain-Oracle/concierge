import { ConciergeError } from '@concierge/sdk';
import { sanitizeError } from '../sanitize.ts';
import type { AgentState, PhaseOutcome } from '../types.ts';
import type { ExecuteOutcome, ExecutionRow } from './executeSchema.ts';

/** Mantle block time ~6s; 30s wait = 5 confirmations of margin (per story spec). */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const GAS_DRIFT_THRESHOLD_PCT = 20;
const MIN_WAIT_TIMEOUT_MS = 1_000;
const MAX_REVERT_REASON_LEN = 4096;
/** UserOp hash shape — 0x + 64 hex chars. Rejecting malformed values closes
 * a CWE-117 log-injection vector via executor-supplied hash interpolation. */
const USER_OP_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function defaultDriftLog(msg: string): void {
  // Stderr so the warning is visible even when no logger is wired (round-1:
  // logDrift? optional made drift signal silently disable-able).
  process.stderr.write(`[concierge/runtime] ${msg}\n`);
}

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

function driftPct(actual: bigint, estimate: bigint): number {
  if (estimate === 0n) return Number.POSITIVE_INFINITY;
  // Convert to number via difference / estimate; bounded scale so safe in float.
  const ratio = Number((actual * 10_000n) / estimate) / 10_000;
  return Math.abs(ratio - 1) * 100;
}

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
    userOpHash = submitted.userOpHash;
    if (!USER_OP_HASH_RE.test(userOpHash)) {
      // Defense-in-depth: a malformed userOpHash interpolated into logs and
      // error messages is a CWE-117 vector. Reject at the boundary.
      throw new ConciergeError(
        'InvariantViolation',
        `[@concierge/runtime] runExecute: executor returned malformed userOpHash.`,
      );
    }
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

  // Round-1: abort fired BETWEEN submit-resolve and wait-start. The UserOp is
  // already on the bundler; persisting a timeout row preserves the hash so a
  // late poller can reconcile rather than orphaning the on-chain op DB-side.
  if (signal.aborted) {
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

async function eoaFallback(
  inputs: RunExecuteInputs,
  deps: RunExecuteDeps,
): Promise<PhaseOutcome<ExecuteOutcome>> {
  let queued: { readonly queueId: string };
  try {
    queued = await deps.eoaQueue.enqueue({
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
    });
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute (EOA fallback): enqueue failed: ${safe.message}`,
      safe,
    );
  }
  // Round-1: orphan reconciliation. If the row insert fails AFTER the queue
  // entry is committed, the queueId is structured into the error metadata
  // so ops can cancel the queue row (or hand-insert the missing execution).
  let row: { readonly id: string };
  try {
    row = await deps.repository.insert({
      proposalId: inputs.proposal.id,
      agentId: inputs.state.agentId,
      status: 'awaiting_user_signature',
    });
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute (EOA fallback): row insert failed AFTER queue enqueue; reconcile queueId=${queued.queueId}: ${safe.message}`,
      safe,
      { proposalId: inputs.proposal.id, queueId: queued.queueId },
    );
  }
  return {
    kind: 'continue',
    data: {
      status: 'awaiting_user_signature',
      executionId: row.id,
      queueId: queued.queueId,
    },
  };
}

async function insertOrThrow(
  repo: ExecutionRepository,
  row: ExecutionRow,
): Promise<{ readonly id: string }> {
  try {
    return await repo.insert(row);
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runExecute: execution row insert failed: ${safe.message}`,
      safe,
    );
  }
}
