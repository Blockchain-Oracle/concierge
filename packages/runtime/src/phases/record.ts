import { ConciergeError } from '@concierge/sdk';
import { sanitizeError, sanitizeMessage } from '../sanitize.ts';
import type { AgentState, PhaseOutcome } from '../types.ts';
import { isHash32 } from './hash.ts';
import {
  type AttestationPayload,
  attestationPayloadSchema,
  type RecordOutcome,
} from './recordSchema.ts';

/**
 * Marker class for post-attestation infra failures so the outer catch can
 * distinguish "attachAttestation failed" (uid already on-chain — propagate
 * for reconcile) from "attester.attestAction threw" (queue retry).
 */
class PostAttestInfraError extends Error {
  // Round-2: use the standard Error.cause slot (ES2022) instead of a bespoke
  // `inner` field. One source of truth; future maintainers reading `.cause`
  // can't drift from the marker's payload.
  constructor(cause: ConciergeError) {
    super(cause.message, { cause });
    this.name = 'PostAttestInfraError';
  }
}
function isPostAttestInfra(
  err: unknown,
): err is PostAttestInfraError & { readonly cause: ConciergeError } {
  return err instanceof PostAttestInfraError && err.cause instanceof ConciergeError;
}

/** Trusted output from the originating provider — already validated below. */
export interface ConfirmedExecution {
  readonly executionId: string;
  readonly proposalId: string;
  readonly userOpHash: string;
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly gasUsedActual: bigint;
}

/**
 * DI'd attestation builder. Each provider package implements this so the
 * runtime stays schema-agnostic (per ADR-014 + story spec: "record() doesn't
 * hard-code; it calls provider.buildAttestationPayload() and trusts the result").
 */
export interface AttestationPayloadBuilder {
  build(args: {
    readonly state: AgentState;
    readonly exec: ConfirmedExecution;
    readonly signal: AbortSignal;
  }): Promise<AttestationPayload>;
}

/** ERC-8004 client — production wires the erc8004 provider package. */
export interface Erc8004Client {
  attestAction(args: {
    readonly agentId: string;
    readonly providerSchema: string;
    readonly payload: unknown;
    readonly signal: AbortSignal;
  }): Promise<{ readonly attestationUid: string; readonly attestationTxHash: string }>;
}

/**
 * Reads current attestation state for idempotence; attaches uid on success.
 *
 * **Implementation contract (TOCTOU):** `attachAttestation` MUST be a
 * conditional write that only succeeds when the row's `attestation_uid` is
 * still NULL (e.g., `UPDATE executions SET ... WHERE id=$1 AND
 * attestation_uid IS NULL` returning affected rows, or a UNIQUE constraint
 * + `ON CONFLICT DO NOTHING`). Two concurrent ticks both reading null from
 * `getAttestation` is the documented race; the repo layer is the source of
 * truth that prevents double-attestation. A unique-violation surfacing as
 * a thrown error is correct — the runtime wraps it as
 * `PostAttestInfraError` and operators reconcile from the metadata.
 */
export interface ExecutionAttestationRepository {
  getAttestation(executionId: string): Promise<{ readonly attestationUid: string | null }>;
  attachAttestation(args: {
    readonly executionId: string;
    readonly attestationUid: string;
    readonly attestationTxHash: string;
    readonly recordedAt: Date;
  }): Promise<void>;
}

/**
 * BullMQ retry queue. Attestation failure is non-blocking per the spec — the
 * on-chain action already executed; we just need the receipt to land. Queue
 * a retry instead of throwing.
 */
export interface AttestationRetryQueue {
  enqueue(args: {
    readonly executionId: string;
    readonly proposalId: string;
    readonly agentId: string;
  }): Promise<{ readonly jobId: string }>;
}

export interface RecordLogEntry {
  readonly tickId: string;
  readonly agentId: string;
  readonly phase: 'record';
  readonly durationMs: number;
  readonly attestationUid: string | null;
  readonly txHash: string;
  readonly outcome: RecordOutcome['kind'];
}

export interface RunRecordInputs {
  readonly state: AgentState;
  readonly tickId: string;
  readonly exec: ConfirmedExecution;
}

export interface RunRecordDeps {
  readonly builder: AttestationPayloadBuilder;
  readonly attester: Erc8004Client;
  readonly repository: ExecutionAttestationRepository;
  readonly retryQueue: AttestationRetryQueue;
  readonly now: () => Date;
  readonly logRecord?: (entry: RecordLogEntry) => void;
  readonly abortSignal?: AbortSignal;
}

const NEVER_ABORT = new AbortController().signal;

/**
 * Defensive stringify — a hostile/buggy Erc8004Client could return a value
 * whose `.toString()` throws or returns control bytes. Wrap so the surface
 * cannot crash the log/throw path (CWE-117 hardening).
 */
function safeStringify(v: unknown): string {
  try {
    return sanitizeMessage(String(v)).slice(0, 256);
  } catch {
    return '<unprintable>';
  }
}

/**
 * Validate provider-built payload at the runtime boundary. Schema length cap
 * lives in the Zod schema itself (.max(128)); we just run safeParse and
 * sanitize the error.message before interpolation (CWE-117).
 */
function validatePayload(p: AttestationPayload): AttestationPayload {
  const parsed = attestationPayloadSchema.safeParse(p);
  if (!parsed.success) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runRecord: provider attestation payload malformed: ${sanitizeMessage(parsed.error.message)}`,
    );
  }
  return parsed.data;
}

/**
 * Record-phase entry. Path matrix:
 *   - row already has attestationUid → already_attested (idempotent)
 *   - attestAction succeeds → attached + attested
 *   - attestAction throws  → retry queued (non-blocking per ADR-004)
 *
 * Throws ConciergeError only for INFRA (repository read/write failure,
 * retry-queue enqueue failure). The retry path itself is a domain outcome,
 * not a thrown error — orchestrator continues regardless.
 */
export async function runRecord(
  inputs: RunRecordInputs,
  deps: RunRecordDeps,
): Promise<PhaseOutcome<RecordOutcome>> {
  if (!isHash32(inputs.exec.txHash)) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/runtime] runRecord: exec.txHash must be a 32-byte hex.`,
    );
  }
  const signal = deps.abortSignal ?? NEVER_ABORT;
  const started = deps.now();

  // Idempotence + TOCTOU:
  // The getAttestation null check is racy by construction — two concurrent
  // ticks reading null both proceed to attestAction (double on-chain attest).
  // The PRODUCTION fix lives in the ExecutionAttestationRepository contract:
  // attachAttestation MUST be a conditional `UPDATE … WHERE attestation_uid
  // IS NULL` (or `INSERT … ON CONFLICT DO NOTHING RETURNING`), with the
  // second writer surfacing as a unique-violation. The unique-violation is
  // then caught by the inner try below and wrapped as a
  // PostAttestInfraError → reconcile path. The runtime layer cannot prevent
  // the race; we document it here so the contract is visible to readers.
  let existing: { readonly attestationUid: string | null };
  try {
    existing = await deps.repository.getAttestation(inputs.exec.executionId);
  } catch (err) {
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runRecord: getAttestation failed (executionId=${inputs.exec.executionId}): ${safe.message}`,
      safe,
      { executionId: inputs.exec.executionId, agentId: inputs.state.agentId },
    );
  }
  if (existing.attestationUid !== null) {
    const outcome: RecordOutcome = {
      kind: 'already_attested',
      executionId: inputs.exec.executionId,
      attestationUid: existing.attestationUid,
    };
    emit(deps, inputs, outcome, started, inputs.exec.txHash);
    return { kind: 'continue', data: outcome };
  }

  let payload: AttestationPayload;
  try {
    const built = await deps.builder.build({ state: inputs.state, exec: inputs.exec, signal });
    payload = validatePayload(built);
  } catch (err) {
    if (err instanceof ConciergeError && err.type === 'InvariantViolation') throw err;
    const safe = sanitizeError(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] runRecord: buildAttestationPayload failed: ${safe.message}`,
      safe,
      { executionId: inputs.exec.executionId, agentId: inputs.state.agentId },
    );
  }

  try {
    const { attestationUid, attestationTxHash } = await deps.attester.attestAction({
      agentId: inputs.state.agentId,
      providerSchema: payload.providerSchema,
      payload: payload.payload,
      signal,
    });
    if (
      typeof attestationUid !== 'string' ||
      typeof attestationTxHash !== 'string' ||
      !isHash32(attestationUid) ||
      !isHash32(attestationTxHash)
    ) {
      // Surface the raw response BEFORE throwing so ops can manually
      // reconcile the on-chain attestation that almost certainly already
      // landed (the bundler returned something — just wrong-shaped).
      const rawUidSafe = safeStringify(attestationUid);
      const rawTxSafe = safeStringify(attestationTxHash);
      deps.logRecord?.({
        tickId: inputs.tickId,
        agentId: inputs.state.agentId,
        phase: 'record',
        durationMs: deps.now().getTime() - started.getTime(),
        attestationUid: rawUidSafe,
        txHash: inputs.exec.txHash,
        outcome: 'attested',
      });
      throw new ConciergeError(
        'InvariantViolation',
        `[@concierge/runtime] runRecord: ERC-8004 returned malformed uid/txHash; raw uid=${rawUidSafe} raw txHash=${rawTxSafe}.`,
      );
    }
    // Normalize uid + txHash to lowercase BEFORE persist/return. EAS uids
    // are bytes32; case is not semantically meaningful on-chain. Consumers
    // (off-chain reads, dedup, eq() queries) MUST query lowercased.
    try {
      await deps.repository.attachAttestation({
        executionId: inputs.exec.executionId,
        attestationUid: attestationUid.toLowerCase(),
        attestationTxHash: attestationTxHash.toLowerCase(),
        recordedAt: deps.now(),
      });
    } catch (err) {
      const safe = sanitizeError(err);
      throw new PostAttestInfraError(
        new ConciergeError(
          'RpcError',
          `[@concierge/runtime] runRecord: attachAttestation failed (uid=${attestationUid.toLowerCase()}): ${safe.message}`,
          safe,
          {
            executionId: inputs.exec.executionId,
            agentId: inputs.state.agentId,
            attestationUid: attestationUid.toLowerCase(),
            attestationTxHash: attestationTxHash.toLowerCase(),
          },
        ),
      );
    }
    const outcome: RecordOutcome = {
      kind: 'attested',
      executionId: inputs.exec.executionId,
      attestationUid: attestationUid.toLowerCase(),
      attestationTxHash: attestationTxHash.toLowerCase(),
    };
    emit(deps, inputs, outcome, started, inputs.exec.txHash);
    return { kind: 'continue', data: outcome };
  } catch (err) {
    // Precise filter: only post-attestAction infra failure (attachAttestation)
    // and our own InvariantViolation throws skip the retry queue. Crucially,
    // a ConciergeError raised by the attester (provider-package implementation
    // detail) is treated as a normal attest failure and queued. Without this,
    // a provider switching to ConciergeError would silently break ADR-004
    // non-blocking semantics.
    if (isPostAttestInfra(err)) throw err.cause;
    if (err instanceof ConciergeError && err.type === 'InvariantViolation') throw err;
    const attestErr = sanitizeError(err);
    // Non-blocking per ADR-004: attestation queues for retry; tick proceeds.
    let job: { readonly jobId: string };
    try {
      job = await deps.retryQueue.enqueue({
        executionId: inputs.exec.executionId,
        proposalId: inputs.exec.proposalId,
        agentId: inputs.state.agentId,
      });
    } catch (queueErr) {
      // Retry queue is itself infra — if THIS fails the attestation is truly
      // lost; surface loudly so ops can manually replay from the executions row.
      const safe = sanitizeError(queueErr);
      throw new ConciergeError(
        'RpcError',
        `[@concierge/runtime] runRecord: retry queue enqueue failed after attestAction error; manual reconcile required (executionId=${inputs.exec.executionId} proposalId=${inputs.exec.proposalId}): ${safe.message}; original attest cause: ${attestErr.message}`,
        safe,
        {
          executionId: inputs.exec.executionId,
          agentId: inputs.state.agentId,
          proposalId: inputs.exec.proposalId,
          originalAttestCause: attestErr.message,
        },
      );
    }
    const outcome: RecordOutcome = {
      kind: 'retry_queued',
      executionId: inputs.exec.executionId,
      retryJobId: job.jobId,
    };
    emit(deps, inputs, outcome, started, inputs.exec.txHash);
    return { kind: 'continue', data: outcome };
  }
}

function emit(
  deps: RunRecordDeps,
  inputs: RunRecordInputs,
  outcome: RecordOutcome,
  started: Date,
  txHash: string,
): void {
  if (deps.logRecord === undefined) return;
  const durationMs = deps.now().getTime() - started.getTime();
  const attestationUid =
    outcome.kind === 'attested' || outcome.kind === 'already_attested'
      ? outcome.attestationUid
      : null;
  deps.logRecord({
    tickId: inputs.tickId,
    agentId: inputs.state.agentId,
    phase: 'record',
    durationMs,
    attestationUid,
    txHash,
    outcome: outcome.kind,
  });
}
