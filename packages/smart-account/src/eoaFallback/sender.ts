import type { DbClient } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import type { Hex, PublicClient } from 'viem';
import { markConfirmed, markFailed, markSigned, type QueueRow } from './queue.ts';

const SIGNED_TX_RE = /^0x[0-9a-fA-F]+$/;

export interface SendSignedTxConfig {
  readonly db: DbClient;
  readonly publicClient: PublicClient;
  readonly queueId: string;
  readonly signedTx: Hex;
  /**
   * Polling timeout for waitForTransactionReceipt (ms). Default 60_000.
   * Mantle blocks ~2s — 60s allows ~30 blocks of reorg-tolerance headroom.
   */
  readonly receiptTimeoutMs?: number;
}

export type SendSignedTxResult =
  | { kind: 'confirmed'; row: QueueRow }
  | { kind: 'failed'; row: QueueRow; error: string };

const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;

/**
 * Broadcast a user-signed raw tx + watch for receipt.
 *
 *   pending --sendRawTransaction--> signed --receipt OK--> confirmed
 *                              \--receipt revert/timeout--> failed
 *
 * The first leg (sendRawTransaction → markSigned) and the second leg
 * (waitForTransactionReceipt → markConfirmed/Failed) are separate DB writes
 * so an operator inspecting eoa_tx_queue mid-flight always sees the truthy
 * state of "did we hit the chain or not".
 *
 * Errors:
 *  - Pre-broadcast viem error → markFailed with the sanitized message; the
 *    row never reaches 'signed'. Caller gets `{ kind: 'failed' }` (NOT a throw)
 *    so the UI can render the failure without try/catch ceremony.
 *  - Post-broadcast revert or timeout → markFailed. Same shape.
 */
export async function sendSignedTx(config: SendSignedTxConfig): Promise<SendSignedTxResult> {
  if (!SIGNED_TX_RE.test(config.signedTx)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: signedTx is not 0x-prefixed hex.`,
    );
  }

  let txHash: Hex;
  try {
    txHash = await config.publicClient.sendRawTransaction({
      serializedTransaction: config.signedTx,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const row = await markFailed(config.db, { id: config.queueId, error: msg });
    if (!row) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] sendSignedTx: queue row '${config.queueId}' not found while recording pre-broadcast failure.`,
      );
    }
    return { kind: 'failed', row, error: msg };
  }

  const signedRow = await markSigned(config.db, {
    id: config.queueId,
    signedTx: config.signedTx,
    txHash,
  });
  if (!signedRow) {
    // Concurrent caller already signed this row — operator-visible bug, not
    // a silent swallow. The chain accepted our broadcast but our DB state
    // says someone else owns this id.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] sendSignedTx: queue row '${config.queueId}' was not in 'pending' state when markSigned ran. Possible double-fire.`,
    );
  }

  const timeout = config.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  try {
    const receipt = await config.publicClient.waitForTransactionReceipt({ hash: txHash, timeout });
    if (receipt.status === 'reverted') {
      const reason = `tx reverted on-chain (block ${receipt.blockNumber.toString()})`;
      const row = await markFailed(config.db, { id: config.queueId, error: reason });
      // signedRow is the right fallback if markFailed somehow returned null,
      // but markFailed has no state-gate so it should always return the row.
      return { kind: 'failed', row: row ?? signedRow, error: reason };
    }
    const confirmedRow = await markConfirmed(config.db, {
      id: config.queueId,
      blockNumber: receipt.blockNumber,
    });
    return { kind: 'confirmed', row: confirmedRow ?? signedRow };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const row = await markFailed(config.db, { id: config.queueId, error: msg });
    return { kind: 'failed', row: row ?? signedRow, error: msg };
  }
}
