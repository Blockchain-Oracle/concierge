import type { DbClient } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import {
  type Address,
  type Hex,
  type PublicClient,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import { z } from 'zod';
import { markConfirmed, markFailed, markSigned, type QueueRow } from './queue.ts';

const uuidSchema = z.string().uuid();
const userIdSchema = z.string().min(1).max(256);
/** byte-aligned hex, sane upper bound (256 KB serialized tx covers any realistic payload). */
const signedTxSchema = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/)
  .refine((s) => s.length <= 512_002, { message: 'signedTx exceeds 256 KB' });

export interface SendSignedTxConfig {
  readonly db: DbClient;
  readonly publicClient: PublicClient;
  readonly queueId: string;
  /** Mirrors story-54 IDOR defense — UPDATE/SELECT WHERE binds userId. */
  readonly expectedUserId: string;
  /** Chain id the signed tx MUST encode. Mantle Mainnet 5000, Sepolia 5003. */
  readonly expectedChainId: number;
  /** EOA owner address — the signer recovered from signedTx MUST match. */
  readonly expectedSigner: Address;
  readonly signedTx: Hex;
  /** waitForTransactionReceipt timeout (ms). Default 180_000 — Mantle confirms ~2-5s but sequencer hiccups happen. */
  readonly receiptTimeoutMs?: number;
}

export type SendSignedTxResult =
  | { kind: 'confirmed'; row: QueueRow }
  | { kind: 'failed'; row: QueueRow; error: ConciergeError }
  /**
   * Receipt timed out but the tx is still in the mempool — DB stays at
   * 'signed', caller (cron worker) re-checks later. NEVER markFailed in this
   * branch: a 'failed' over a later-confirming tx writes a bad ERC-8004
   * attestation downstream.
   */
  | { kind: 'pending-confirmation'; txHash: Hex; row: QueueRow };

const DEFAULT_RECEIPT_TIMEOUT_MS = 180_000;
const URL_API_KEY_RE = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"'<>]+/gi;

/** Strips apikey/token URL params before persisting viem errors to DB or logs. */
function sanitizeMessage(input: string): string {
  return input.replace(URL_API_KEY_RE, '$1<redacted>');
}

function sanitizeViemError(err: unknown): { message: string; cause: unknown } {
  if (err instanceof Error) {
    const message = sanitizeMessage(err.message);
    return { message, cause: err };
  }
  return { message: sanitizeMessage(String(err)), cause: err };
}

/**
 * Broadcasts a user-signed raw tx.
 *
 * Defense pipeline before broadcast (security CRITICAL — CWE-345):
 *   1. queueId UUID-validated.
 *   2. SELECT the row pinned to expectedUserId (IDOR defense).
 *   3. parseTransaction(signedTx) → assert to/data/value/chainId match the
 *      proposal. Without this, an attacker submitting a totally different
 *      signed payload would broadcast (and we'd log "user approved Q").
 *   4. recoverTransactionAddress(signedTx) → assert signer == expectedSigner.
 *
 * State pipeline after broadcast:
 *   sendRawTransaction → markSigned (status='signed').
 *   waitForTransactionReceipt → markConfirmed | markFailed | pending-confirmation.
 */
export async function sendSignedTx(config: SendSignedTxConfig): Promise<SendSignedTxResult> {
  // --- boundary validation ---
  if (!uuidSchema.safeParse(config.queueId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: queueId is not a valid UUID.`,
    );
  }
  if (!userIdSchema.safeParse(config.expectedUserId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: expectedUserId must be 1-256 chars.`,
    );
  }
  if (!signedTxSchema.safeParse(config.signedTx).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: signedTx is not byte-aligned hex or exceeds 256 KB.`,
    );
  }

  // --- proposal binding ---
  await assertSignedTxBindsProposal(config);

  // --- broadcast ---
  let txHash: Hex;
  try {
    txHash = await config.publicClient.sendRawTransaction({
      serializedTransaction: config.signedTx,
    });
  } catch (err) {
    return await failTerminal(config, err, 'pre-broadcast');
  }

  // --- markSigned ---
  const signedResult = await markSigned(config.db, {
    id: config.queueId,
    expectedUserId: config.expectedUserId,
    signedTx: config.signedTx,
    txHash,
  });
  if (signedResult.kind !== 'updated') {
    // Operator-visible invariant violation: chain accepted our broadcast but
    // our DB state disagrees about who owns the row. Throw, don't markFailed.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: markSigned returned '${signedResult.kind}' for queueId '${config.queueId}' — chain broadcast already happened. Investigate.`,
    );
  }
  const signedRow = signedResult.row;

  // --- wait for receipt ---
  const timeout = config.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  try {
    const receipt = await config.publicClient.waitForTransactionReceipt({ hash: txHash, timeout });
    if (receipt.status === 'reverted') {
      const reason = `tx reverted on-chain (tx ${txHash} block ${receipt.blockNumber.toString()})`;
      return await failPostBroadcast(config, signedRow, reason);
    }
    const confirmed = await markConfirmed(config.db, {
      id: config.queueId,
      expectedUserId: config.expectedUserId,
      blockNumber: receipt.blockNumber,
    });
    if (confirmed.kind === 'updated') return { kind: 'confirmed', row: confirmed.row };
    if (confirmed.kind === 'wrong-state' && confirmed.current.status === 'confirmed') {
      // Concurrent worker already wrote the same outcome — idempotent OK.
      return { kind: 'confirmed', row: confirmed.current };
    }
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: markConfirmed returned '${confirmed.kind}' for queueId '${config.queueId}' after chain receipt confirmed. Investigate.`,
    );
  } catch (err) {
    // CRITICAL: timeout does NOT mean failure — the tx may still confirm.
    // Probe the mempool. If found, leave the row at 'signed' and return
    // pending-confirmation so the caller polls again. Only markFailed when
    // the chain has clearly rejected the tx (mempool miss + send error).
    const reconciled = await reconcileTimeout(config, txHash, signedRow, err);
    return reconciled;
  }
}

async function assertSignedTxBindsProposal(config: SendSignedTxConfig): Promise<void> {
  // SELECT row by id pinned to expectedUserId. Row may not exist (caller
  // bug / wrong id) or belong to another tenant — both fail closed.
  const { eoaTxQueue } = await import('@concierge/db');
  const { eq, and } = await import('drizzle-orm');
  // biome-ignore lint/suspicious/noExplicitAny: drizzle import shape
  const rows = await (config.db as any)
    .select()
    .from(eoaTxQueue)
    .where(and(eq(eoaTxQueue.id, config.queueId), eq(eoaTxQueue.userId, config.expectedUserId)))
    .limit(1);
  const row = rows[0] as QueueRow | undefined;
  if (!row) {
    // NotFound or wrong tenant — same shape (no info leak).
    throw new ConciergeError(
      'NotAuthorized',
      `[@concierge/smart-account] sendSignedTx: caller is not authorized to broadcast for queueId '${config.queueId}'.`,
    );
  }
  if (row.status !== 'pending') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: queue row '${config.queueId}' is in status '${row.status}' — only 'pending' rows can be broadcast.`,
    );
  }

  // Parse signed tx + verify it encodes the SAME (to, data, value, chainId)
  // as the queued proposal. Without this check, a malicious caller could swap
  // the signed payload while the audit row claims "user approved Q".
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(config.signedTx);
  } catch (err) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: failed to parse signedTx as a transaction.`,
      err instanceof Error ? new Error(sanitizeMessage(err.message)) : err,
    );
  }

  if ((parsed.chainId ?? 0) !== config.expectedChainId) {
    throw new ConciergeError(
      'NetworkUnsupported',
      `[@concierge/smart-account] sendSignedTx: signedTx chainId ${parsed.chainId} != expected ${config.expectedChainId}.`,
    );
  }
  if (typeof parsed.to !== 'string' || parsed.to.toLowerCase() !== row.to.toLowerCase()) {
    throw new ConciergeError(
      'NotAuthorized',
      `[@concierge/smart-account] sendSignedTx: signedTx.to does not match queued proposal — refusing to broadcast.`,
    );
  }
  const parsedData = (parsed.data ?? '0x') as Hex;
  if (parsedData.toLowerCase() !== row.data.toLowerCase()) {
    throw new ConciergeError(
      'NotAuthorized',
      `[@concierge/smart-account] sendSignedTx: signedTx.data does not match queued proposal — refusing to broadcast.`,
    );
  }
  const parsedValue = parsed.value ?? 0n;
  if (parsedValue !== BigInt(row.value)) {
    throw new ConciergeError(
      'NotAuthorized',
      `[@concierge/smart-account] sendSignedTx: signedTx.value (${parsedValue.toString()}) != queued (${row.value}).`,
    );
  }

  // Recover signer and assert it matches the expected EOA owner.
  let signer: Address;
  try {
    signer = await recoverTransactionAddress({
      // viem brands serializedTransaction with the typed-tx prefix; signedTx
      // has already been parsed by parseTransaction above, so this is sound.
      serializedTransaction: config.signedTx as `0x02${string}`,
    });
  } catch (err) {
    throw new ConciergeError(
      'InvalidOwnerSignature',
      `[@concierge/smart-account] sendSignedTx: could not recover signer from signedTx.`,
      err instanceof Error ? new Error(sanitizeMessage(err.message)) : err,
    );
  }
  if (signer.toLowerCase() !== config.expectedSigner.toLowerCase()) {
    throw new ConciergeError(
      'InvalidOwnerSignature',
      `[@concierge/smart-account] sendSignedTx: signedTx signer ${signer} != expected ${config.expectedSigner}.`,
    );
  }
}

async function failTerminal(
  config: SendSignedTxConfig,
  err: unknown,
  phase: 'pre-broadcast',
): Promise<SendSignedTxResult> {
  const { message, cause } = sanitizeViemError(err);
  const result = await markFailed(config.db, {
    id: config.queueId,
    expectedUserId: config.expectedUserId,
    error: `${phase}: ${message}`,
  });
  if (result.kind !== 'updated') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: markFailed returned '${result.kind}' while recording ${phase} failure for '${config.queueId}'.`,
    );
  }
  return {
    kind: 'failed',
    row: result.row,
    error: new ConciergeError('RpcError', message, cause),
  };
}

async function failPostBroadcast(
  config: SendSignedTxConfig,
  signedRow: QueueRow,
  reason: string,
): Promise<SendSignedTxResult> {
  const result = await markFailed(config.db, {
    id: config.queueId,
    expectedUserId: config.expectedUserId,
    error: reason,
  });
  // wrong-state with status='confirmed' means a concurrent worker recorded
  // success first — DO NOT contradict; the chain is authoritative.
  if (result.kind === 'wrong-state' && result.current.status === 'confirmed') {
    return { kind: 'confirmed', row: result.current };
  }
  if (result.kind !== 'updated') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: markFailed returned '${result.kind}' for '${config.queueId}' after on-chain revert. Investigate.`,
    );
  }
  return {
    kind: 'failed',
    row: result.row,
    error: new ConciergeError('RpcError', reason),
  };
}

async function reconcileTimeout(
  config: SendSignedTxConfig,
  txHash: Hex,
  signedRow: QueueRow,
  err: unknown,
): Promise<SendSignedTxResult> {
  // Probe the chain: is the tx already mined, or still pending?
  try {
    const tx = await config.publicClient.getTransaction({ hash: txHash });
    if (tx) {
      // Found in mempool or already mined but receipt not yet returned.
      // Leave row at 'signed'; caller's reconciler polls.
      return { kind: 'pending-confirmation', txHash, row: signedRow };
    }
  } catch {
    // getTransaction throws "not found" for dropped txs — fall through.
  }
  // Truly dropped — terminal failure.
  const { message } = sanitizeViemError(err);
  return await failPostBroadcast(config, signedRow, `timeout: ${message}`);
}
