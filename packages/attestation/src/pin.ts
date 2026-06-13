import { ConciergeError } from '@concierge/sdk';
import { computeFeedbackPair } from './hash.ts';
import { type PinService, type PinServiceName, PinServiceNotConfigured } from './pinService.ts';
import type { FeedbackEnvelope } from './schema.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * PinAttempt is a discriminated union on `ok`. Illegal states
 * (`ok:true` with no cid; `ok:false` with no error) are unrepresentable.
 * The `notConfigured` boolean carries the round-1 sentinel — distinguishes
 * "service refused to run because deps missing" from "service ran and threw."
 */
export type PinAttempt =
  | {
      readonly service: PinServiceName;
      readonly ok: true;
      readonly cid: string;
      readonly pinId: string;
    }
  | {
      readonly service: PinServiceName;
      readonly ok: false;
      readonly error: string;
      readonly notConfigured: boolean;
    };

export interface PinFeedbackResult {
  readonly cid: string;
  readonly canonical: string;
  readonly hash: `0x${string}`;
  readonly primary: PinAttempt;
  readonly fallback: PinAttempt;
  /** True iff both services succeeded AND returned different CIDs (multicodec divergence). */
  readonly cidDivergence: boolean;
}

export interface PinFeedbackDeps {
  readonly primary?: PinService;
  readonly fallback?: PinService;
  readonly logger?: {
    warn(meta: Record<string, unknown>, msg: string): void;
    error(meta: Record<string, unknown>, msg: string): void;
  };
  /**
   * Caller's AbortSignal. If omitted, defaults to `AbortSignal.timeout(15_000)`
   * so a hung connection cannot pin the tick worker indefinitely (round-1
   * security MEDIUM CWE-400 fix).
   */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Canonicalize → keccak256 → pin to BOTH services in parallel for redundancy.
 *
 * Failure matrix:
 *   - both succeed (same CID)     → primary.cid wins; cidDivergence=false
 *   - both succeed (DIFFERENT CIDs) → primary.cid wins; cidDivergence=TRUE; logger.warn fires
 *   - primary ok, fallback throws/not-configured → primary.cid wins
 *   - primary throws, fallback ok → fallback.cid wins; logger.warn fires
 *   - BOTH fail → ConciergeError('IPFSPinFailed', metadata: { primary, fallback, hash, agentId })
 *   - NEITHER configured → ConciergeError('ConfigError', ...) at the boundary
 */
export async function pinFeedback(
  envelope: FeedbackEnvelope,
  deps: PinFeedbackDeps,
): Promise<PinFeedbackResult> {
  if (deps.primary === undefined && deps.fallback === undefined) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/attestation] pinFeedback: at least one of `primary` or `fallback` PinService must be configured.',
    );
  }

  const { hash, canonical } = computeFeedbackPair(envelope);
  const displayName = `concierge-${envelope.agentId}-${envelope.schema}`;
  const signal = deps.signal ?? AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Schedule only configured services. Unconfigured services produce a
  // PinAttempt directly (no rejected promise required) — distinguished by
  // the `notConfigured: true` discriminator so audit queries can split
  // "service was unconfigured" from "service ran and failed."
  const primaryName: PinServiceName = deps.primary?.name ?? 'pinata';
  const fallbackName: PinServiceName = deps.fallback?.name ?? '<unconfigured>';

  const [primaryRes, fallbackRes] = await Promise.allSettled([
    deps.primary
      ? deps.primary.pin({ canonical, displayName, signal })
      : Promise.reject(new PinServiceNotConfigured(primaryName)),
    deps.fallback
      ? deps.fallback.pin({ canonical, displayName, signal })
      : Promise.reject(new PinServiceNotConfigured(fallbackName)),
  ]);

  const primary = toAttempt(primaryName, primaryRes);
  const fallback = toAttempt(fallbackName, fallbackRes);

  if (!primary.ok && !fallback.ok) {
    deps.logger?.error(
      { agentId: envelope.agentId, hash, primary: primary.error, fallback: fallback.error },
      'pinFeedback: both services failed',
    );
    throw new ConciergeError(
      'IPFSPinFailed',
      `[@concierge/attestation] pinFeedback: BOTH services failed. primary=${primary.error} | fallback=${fallback.error}`,
      undefined,
      { hash, agentId: envelope.agentId, primary, fallback },
    );
  }

  // Pick the winner — primary if ok, else fallback (line-99 check guaranteed
  // at least one ok, so the fallback branch is `ok:true` by construction).
  // The cast is the TS-narrowing assertion the type system can't prove across
  // the ternary; round-2 dropped the defensive throw (was unreachable).
  const cid = primary.ok ? primary.cid : (fallback as Extract<PinAttempt, { ok: true }>).cid;

  // CID divergence detection (round-1 silent-failure CRITICAL fix): Pinata
  // dag-pb and a future fallback's `raw` codec produce DIFFERENT CIDs for
  // the same content. The on-chain dataHash binds to CONTENT (keccak256),
  // not the CID, so both CIDs are valid retrieval addresses — but auditors
  // need to see the split. Both CIDs are persisted in the receipt row.
  const cidDivergence = primary.ok && fallback.ok && primary.cid !== fallback.cid;
  if (cidDivergence) {
    deps.logger?.warn(
      {
        agentId: envelope.agentId,
        hash,
        primaryCid: primary.ok ? primary.cid : undefined,
        fallbackCid: fallback.ok ? fallback.cid : undefined,
      },
      'pinFeedback: CID divergence (multicodec — same content, different addresses)',
    );
  }

  if (!primary.ok) {
    deps.logger?.warn(
      { agentId: envelope.agentId, hash, primaryError: primary.error, cid },
      'pinFeedback: primary (Pinata) failed; fallback succeeded',
    );
  }

  return { cid, canonical, hash, primary, fallback, cidDivergence };
}

function toAttempt(
  service: PinServiceName,
  res: PromiseSettledResult<{ readonly cid: string; readonly pinId: string }>,
): PinAttempt {
  if (res.status === 'fulfilled') {
    return { service, ok: true, cid: res.value.cid, pinId: res.value.pinId };
  }
  const reason = res.reason;
  const notConfigured = reason instanceof PinServiceNotConfigured;
  const errMsg = reason instanceof Error ? reason.message : String(reason);
  return { service, ok: false, error: errMsg.slice(0, 512), notConfigured };
}
