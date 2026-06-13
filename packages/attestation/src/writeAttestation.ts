import { ConciergeError } from '@concierge/sdk';
import { computeFeedbackPair } from './hash.ts';
import { type PinFeedbackDeps, type PinFeedbackResult, pinFeedback } from './pin.ts';
import { isValidCid } from './pinService.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope, type SchemaId } from './schema.ts';

const DATAURI_PREFIX = 'ipfs://';
const DEFAULT_ATTEST_TIMEOUT_MS = 60_000;
const UINT256_MAX = 2n ** 256n - 1n;
// Round-2: canonical decimal form ONLY — rejects leading zeros so envelope.agentId
// round-trips by string equality (downstream string comparison wouldn't see '00001' === '1').
const UINT256_CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]{0,77})$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function stripCtrl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CWE-117 mitigation
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

// Round-2 CWE-400: slice BEFORE sanitize so a multi-GB upstream error message
// doesn't materialize through regex replace before truncation.
function safeErrMsg(err: unknown, maxLen: number): string {
  const raw = err instanceof Error ? err.message : String(err);
  return stripCtrl(raw.slice(0, maxLen));
}

/**
 * Pre-computed dataHash + dataURI write to the ReputationRegistry. Matches
 * `giveFeedback(uint256 agentId, ... string feedbackURI, bytes32 feedbackHash)`
 * per research/concierge/03-providers/erc8004.md.
 *
 * **Open contradiction (BLOCKS story-84):** the already-merged story-42
 * `attestAction` provider tool uses EIP-712 typed-data hashing
 * (`hashActionPayload`) for feedbackHash, NOT keccak256 of the canonical
 * content. Per CLAUDE.md non-negotiable, research wins. Resolution path:
 * either amend story-42 to expose a raw-bytes32 variant, or build a new
 * low-level adapter calling giveFeedback directly with our keccak hash.
 * MUST be decided before any story-84 / production wiring.
 */
export interface Erc8004AttestWriter {
  giveFeedback(args: {
    readonly agentId: bigint;
    readonly providerSchema: string;
    readonly dataHash: `0x${string}`;
    readonly dataURI: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly attestationUid: string; readonly txHash: `0x${string}` }>;
}

export interface WriteAttestationInputs {
  readonly agentId: string;
  readonly chainId: number;
  readonly providerSchema: SchemaId;
  readonly payload: unknown;
  /** Optional on-chain tx hash that this attestation is FEEDBACK ABOUT (executed tx). */
  readonly txHash?: `0x${string}`;
  readonly createdAt: string;
}

export interface WriteAttestationDeps {
  readonly pinDeps: PinFeedbackDeps;
  readonly writer: Erc8004AttestWriter;
  readonly logger?: {
    info(meta: Record<string, unknown>, msg: string): void;
    error(meta: Record<string, unknown>, msg: string): void;
  };
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface WriteAttestationResult {
  readonly attestationUid: string;
  readonly cid: string;
  readonly hash: `0x${string}`;
  /** Canonical JSON bytes — same string that was pinned to IPFS; the keccak preimage. */
  readonly canonical: string;
  readonly onChainTxHash: `0x${string}`;
  readonly dataURI: string;
  readonly pin: PinFeedbackResult;
}

function configError(msg: string): ConciergeError {
  return new ConciergeError('ConfigError', `[@concierge/attestation] writeAttestation: ${msg}`);
}

/**
 * Compose the four primitives — envelope build, IPFS pin, content hash,
 * on-chain attest — into ONE function for story-67 record() to call.
 *
 * **Ordering contract (load-bearing):**
 *   1. Boundary fail-fast: agentId, createdAt, caller signal not pre-aborted
 *   2. Build + validate envelope (Zod throws → no IO)
 *   3. computeFeedbackPair: canonical bytes + hash in one pass
 *   4. pinFeedback: IPFS first so the dataURI resolves at on-chain mine time
 *   5. writer.giveFeedback: on-chain reference to the now-pinned CID
 *
 * **NO retries inside.** Typed errors surface to the caller.
 *
 * **No pin rollback on on-chain failure** — CIDs are content-addressed so
 * orphan pins are cheap and re-pinning is idempotent. Both error paths
 * that produce an orphan log via `logOrphanPin` for reconciliation.
 */
export async function writeAttestation(
  inputs: WriteAttestationInputs,
  deps: WriteAttestationDeps,
): Promise<WriteAttestationResult> {
  const now = deps.now ?? (() => new Date());
  const started = now();

  // Round-2 boundary fail-fast: agentId canonical-decimal + uint256-bounded.
  // Rejects: non-decimal, leading zeros, empty, >78 digits (silent-failure #3+#4).
  if (!UINT256_CANONICAL_DECIMAL_RE.test(inputs.agentId)) {
    throw configError(
      `agentId must be a uint256 canonical decimal string with no leading zeros, max 78 digits (got '${stripCtrl(inputs.agentId).slice(0, 64)}').`,
    );
  }
  const agentIdBig = BigInt(inputs.agentId);
  if (agentIdBig > UINT256_MAX) {
    throw configError(`agentId exceeds uint256 max (got '${inputs.agentId.slice(0, 80)}').`);
  }

  // Round-2 createdAt boundary fail-fast (code-reviewer IMPORTANT #2): if
  // Zod's datetime() ever relaxes, malformed timestamps become permanent on IPFS.
  if (!ISO_8601_RE.test(inputs.createdAt)) {
    throw configError(
      `createdAt must be ISO-8601 (got '${stripCtrl(inputs.createdAt).slice(0, 64)}').`,
    );
  }

  // Round-2 silent-failure #3: pre-aborted caller signal short-circuits all
  // downstream IO with no fail-fast budget — surface as ConfigError instead.
  if (deps.signal?.aborted) {
    throw configError('caller AbortSignal already aborted before any IO began.');
  }

  // Step 1: validate envelope at the boundary.
  const envelope: FeedbackEnvelope = {
    v: 1,
    schema: inputs.providerSchema,
    agentId: inputs.agentId,
    chainId: inputs.chainId,
    ...(inputs.txHash !== undefined ? { txHash: inputs.txHash } : {}),
    payload: inputs.payload,
    createdAt: inputs.createdAt,
  };
  try {
    parseFeedbackEnvelope(envelope);
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw configError(`envelope validation failed: ${safeErrMsg(err, 2048)}`);
  }

  // Step 2: canonical bytes + hash in one pass.
  const { hash, canonical } = computeFeedbackPair(envelope);

  // Step 3: pin BEFORE on-chain tx.
  const signal = deps.signal ?? AbortSignal.timeout(DEFAULT_ATTEST_TIMEOUT_MS);
  const pinDeps: PinFeedbackDeps = { ...deps.pinDeps, signal };
  const pin = await pinFeedback(envelope, pinDeps);

  // Shared orphan-pin log — emitted from BOTH post-pin error paths so
  // reconcile workers see every orphan, not just on-chain failures.
  const logOrphanPin = (errName: string, errMessage: string, msg: string): void => {
    deps.logger?.error(
      {
        agentId: inputs.agentId,
        hash,
        orphanCid: pin.cid,
        errName,
        errMessage,
      },
      msg,
    );
  };

  // Round-1 defense-in-depth, round-2 wired to orphan log: if pinService
  // contract is breached (returns malformed CID), the pin is already orphaned
  // — must log before throwing so reconciliation sees it.
  if (!isValidCid(pin.cid)) {
    logOrphanPin(
      'PinServiceContractViolation',
      `pinService returned CID failing isValidCid: '${stripCtrl(pin.cid).slice(0, 128)}'`,
      'writeAttestation: pinService contract breach (orphan pin — manual reconcile required)',
    );
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/attestation] writeAttestation: pinService returned a CID that failed isValidCid post-pin: '${stripCtrl(pin.cid).slice(0, 128)}'.`,
    );
  }
  const dataURI = `${DATAURI_PREFIX}${pin.cid}`;

  // Step 4: on-chain giveFeedback.
  let onChainResult: { readonly attestationUid: string; readonly txHash: `0x${string}` };
  try {
    onChainResult = await deps.writer.giveFeedback({
      agentId: agentIdBig,
      providerSchema: inputs.providerSchema,
      dataHash: hash,
      dataURI,
      signal,
    });
  } catch (err) {
    logOrphanPin(
      err instanceof Error ? err.name : 'unknown',
      safeErrMsg(err, 512),
      'writeAttestation: on-chain giveFeedback failed (pin orphaned but content-addressed; safe to retry)',
    );
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/attestation] writeAttestation: giveFeedback failed AFTER successful pin (cid=${pin.cid}): ${safeErrMsg(err, 512)}`,
      err instanceof Error ? err : undefined,
      { agentId: inputs.agentId, hash, cid: pin.cid, dataURI },
    );
  }

  const durationMs = now().getTime() - started.getTime();
  deps.logger?.info(
    {
      attestationUid: onChainResult.attestationUid,
      cid: pin.cid,
      hash,
      onChainTxHash: onChainResult.txHash,
      durationMs,
      providerSchema: inputs.providerSchema,
      cidDivergence: pin.cidDivergence,
    },
    'writeAttestation: on-chain attestation written',
  );

  return {
    attestationUid: onChainResult.attestationUid,
    cid: pin.cid,
    hash,
    canonical,
    onChainTxHash: onChainResult.txHash,
    dataURI,
    pin,
  };
}
