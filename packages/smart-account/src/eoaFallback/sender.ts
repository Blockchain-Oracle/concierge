import { type DbClient, eoaTxQueue } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { and, eq } from 'drizzle-orm';
import {
  type Address,
  type Hex,
  type PublicClient,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
} from 'viem';
import { z } from 'zod';
import { markConfirmed, markFailed, markSigned, type QueueRow } from './queue.ts';
import { sanitizeError, sanitizeMessage } from './sanitize.ts';

const uuidSchema = z.string().uuid();
const userIdSchema = z.string().min(1).max(256);
/** byte-aligned hex, sane upper bound (128 KB serialized tx covers Mantle's realistic ceiling). */
const signedTxSchema = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/)
  .refine((s) => s.length <= 256_002, { message: 'signedTx exceeds 128 KB' });

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
  /** waitForTransactionReceipt timeout (ms). Default 180_000 — Mantle ~2-5s but sequencer hiccups happen. */
  readonly receiptTimeoutMs?: number;
}

export type SendSignedTxResult =
  | { kind: 'confirmed'; row: QueueRow }
  | { kind: 'failed'; row: QueueRow; error: ConciergeError }
  /**
   * Receipt timed out OR getTransaction probe inconclusive — DB stays at
   * 'signed', caller's reconciler re-checks later. NEVER markFailed in this
   * branch: a 'failed' over a later-confirming tx writes a bad ERC-8004
   * attestation downstream.
   */
  | { kind: 'pending-confirmation'; txHash: Hex; row: QueueRow };

const DEFAULT_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * Broadcasts a user-signed raw tx.
 *
 * Defense pipeline before broadcast (security CRITICAL — CWE-345):
 *   1. queueId UUID-validated.
 *   2. SELECT the row pinned to expectedUserId (IDOR defense).
 *   3. Lock tx type: require EIP-1559 + reject accessList. Without this,
 *      arbitrary auxiliary fields could ride along the bound (to,data,value).
 *   4. parseTransaction → assert to/data/value/chainId match the proposal.
 *   5. recoverTransactionAddress → assert signer == expectedSigner.
 *
 * NOTE: there is a TOCTOU window between the SELECT and sendRawTransaction —
 * a concurrent worker can advance the row before our markSigned runs. This
 * is documented + flagged for follow-up (pre-broadcast CAS reservation).
 */
export async function sendSignedTx(config: SendSignedTxConfig): Promise<SendSignedTxResult> {
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
      `[@concierge/smart-account] sendSignedTx: signedTx is not byte-aligned hex or exceeds 128 KB.`,
    );
  }

  await assertSignedTxBindsProposal(config);

  let txHash: Hex;
  try {
    txHash = await config.publicClient.sendRawTransaction({
      serializedTransaction: config.signedTx,
    });
  } catch (err) {
    return await failTerminal(config, err, 'pre-broadcast');
  }

  const signedResult = await markSigned(config.db, {
    id: config.queueId,
    expectedUserId: config.expectedUserId,
    signedTx: config.signedTx,
    txHash,
  });
  if (signedResult.kind !== 'updated' && signedResult.kind !== 'lost-race') {
    // Operator-visible invariant violation: chain accepted our broadcast but
    // DB state disagrees about who owns the row. Throw, don't markFailed.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: markSigned returned '${signedResult.kind}' for queueId '${config.queueId}' — chain broadcast already happened. Investigate.`,
    );
  }
  // lost-race here means a concurrent worker already wrote 'signed' for this
  // row — chain accepted (likely 'already known' from the bundler, or both
  // workers got the same tx hash). Treat as idempotent and proceed with the
  // current row state. Audit log surface (S2 follow-up) records the race.
  const signedRow = signedResult.kind === 'updated' ? signedResult.row : signedResult.current;

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
    if (
      (confirmed.kind === 'wrong-state' || confirmed.kind === 'lost-race') &&
      confirmed.current.status === 'confirmed'
    ) {
      // Concurrent worker recorded the same outcome — idempotent OK.
      return { kind: 'confirmed', row: confirmed.current };
    }
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: markConfirmed returned '${confirmed.kind}' for queueId '${config.queueId}' after chain receipt confirmed. Investigate.`,
    );
  } catch (err) {
    return await reconcileTimeout(config, txHash, signedRow, err);
  }
}

async function assertSignedTxBindsProposal(config: SendSignedTxConfig): Promise<void> {
  const [row] = await config.db
    .select()
    .from(eoaTxQueue)
    .where(and(eq(eoaTxQueue.id, config.queueId), eq(eoaTxQueue.userId, config.expectedUserId)))
    .limit(1);
  if (!row) {
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

  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(config.signedTx);
  } catch (err) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: failed to parse signedTx as a transaction.`,
      sanitizeError(err),
    );
  }

  // Lock tx type to EIP-1559. Without this, EIP-2930 accessList or legacy
  // tx fields could ride along while (to,data,value,chainId) still match.
  if (parsed.type !== 'eip1559') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: only EIP-1559 transactions are accepted; got '${parsed.type}'.`,
    );
  }
  // EIP-1559 also supports accessList — reject anything non-empty.
  if (parsed.accessList && parsed.accessList.length > 0) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: signedTx carries a non-empty accessList — not allowed for EOA-fallback proposals.`,
    );
  }
  if ((parsed.chainId ?? 0) !== config.expectedChainId) {
    throw new ConciergeError(
      'NetworkUnsupported',
      `[@concierge/smart-account] sendSignedTx: signedTx chainId ${parsed.chainId} != expected ${config.expectedChainId}.`,
    );
  }
  if (typeof parsed.to !== 'string') {
    // null = contract-creation. We don't support those via EOA fallback —
    // the audit row carries a `to` address; contract creation has none.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: signedTx is a contract-creation tx (to=null) — not supported.`,
    );
  }
  if (parsed.to.toLowerCase() !== row.to.toLowerCase()) {
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

  let signer: Address;
  try {
    signer = await recoverTransactionAddress({
      serializedTransaction: config.signedTx as `0x02${string}`,
    });
  } catch (err) {
    throw new ConciergeError(
      'InvalidOwnerSignature',
      `[@concierge/smart-account] sendSignedTx: could not recover signer from signedTx.`,
      sanitizeError(err),
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
  const sanitized = sanitizeError(err);
  const result = await markFailed(config.db, {
    id: config.queueId,
    expectedUserId: config.expectedUserId,
    error: `${phase}: ${sanitized.message}`,
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
    error: new ConciergeError('RpcError', sanitized.message, sanitized),
  };
}

async function failPostBroadcast(
  config: SendSignedTxConfig,
  _signedRow: QueueRow,
  reason: string,
): Promise<SendSignedTxResult> {
  const result = await markFailed(config.db, {
    id: config.queueId,
    expectedUserId: config.expectedUserId,
    error: reason,
  });
  // wrong-state / lost-race with status='confirmed' means a concurrent worker
  // recorded success first — chain is authoritative. Warn so the operator
  // sees the divergence in logs (we're about to discard the revert reason).
  if (
    (result.kind === 'wrong-state' || result.kind === 'lost-race') &&
    result.current.status === 'confirmed'
  ) {
    // biome-ignore lint/suspicious/noConsole: operator-visible divergence between local revert observation and chain-authoritative confirmation
    console.warn(
      `[@concierge/smart-account] sendSignedTx: chain-confirmed result raced our markFailed for '${config.queueId}'. Discarding reason: ${reason}`,
    );
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
  // Probe the chain: is the tx still in the mempool / pending?
  try {
    const tx = await config.publicClient.getTransaction({ hash: txHash });
    if (tx) {
      return { kind: 'pending-confirmation', txHash, row: signedRow };
    }
  } catch (probeErr) {
    // FAIL-OPEN: only viem's TransactionNotFoundError counts as "truly
    // dropped". Anything else (RPC outage, rate-limit, network partition)
    // returns pending-confirmation so a downstream poller can retry — never
    // markFailed on an RPC blip (would write a bad ERC-8004 attestation).
    if (!(probeErr instanceof TransactionNotFoundError)) {
      // biome-ignore lint/suspicious/noConsole: RPC probe outage must be observable for ops
      console.warn(
        `[@concierge/smart-account] sendSignedTx: getTransaction probe failed for '${txHash}' — assuming pending. Error: ${sanitizeMessage(probeErr instanceof Error ? probeErr.message : String(probeErr))}`,
      );
      return { kind: 'pending-confirmation', txHash, row: signedRow };
    }
  }
  // Truly dropped (TransactionNotFoundError) — terminal failure.
  const sanitized = sanitizeError(err);
  return await failPostBroadcast(config, signedRow, `timeout: ${sanitized.message}`);
}
