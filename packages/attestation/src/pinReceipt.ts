import { ConciergeError } from '@concierge/sdk';
import type { PinAttempt, PinFeedbackResult } from './pin.ts';

/**
 * Row shape persisted to `pin_receipts`. Round-1: stores BOTH service CIDs
 * (round-0 lost the fallback CID when divergence happened) and the explicit
 * `notConfigured` flag distinguishing "service unconfigured" from "service
 * ran and failed."
 */
export interface PinReceiptRow {
  readonly cid: string;
  readonly agentId: string;
  readonly hash: `0x${string}`;
  readonly cidDivergence: boolean;
  readonly primaryService: string;
  readonly primaryCid: string | null;
  readonly primaryPinId: string | null;
  readonly primaryOk: boolean;
  readonly primaryError: string | null;
  readonly primaryNotConfigured: boolean;
  readonly fallbackService: string;
  readonly fallbackCid: string | null;
  readonly fallbackPinId: string | null;
  readonly fallbackOk: boolean;
  readonly fallbackError: string | null;
  readonly fallbackNotConfigured: boolean;
}

export interface PinReceiptRepository {
  insert(row: PinReceiptRow): Promise<{ readonly id: string }>;
}

export interface RecordPinReceiptInputs {
  readonly agentId: string;
  readonly result: PinFeedbackResult;
}

function attemptToRow(a: PinAttempt): {
  cid: string | null;
  pinId: string | null;
  error: string | null;
  notConfigured: boolean;
  ok: boolean;
} {
  if (a.ok) {
    return { cid: a.cid, pinId: a.pinId, error: null, notConfigured: false, ok: true };
  }
  return { cid: null, pinId: null, error: a.error, notConfigured: a.notConfigured, ok: false };
}

export async function recordPinReceipt(
  inputs: RecordPinReceiptInputs,
  deps: { readonly repository: PinReceiptRepository },
): Promise<{ readonly id: string }> {
  const { result, agentId } = inputs;
  const p = attemptToRow(result.primary);
  const f = attemptToRow(result.fallback);
  const row: PinReceiptRow = {
    cid: result.cid,
    agentId,
    hash: result.hash,
    cidDivergence: result.cidDivergence,
    primaryService: result.primary.service,
    primaryCid: p.cid,
    primaryPinId: p.pinId,
    primaryOk: p.ok,
    primaryError: p.error,
    primaryNotConfigured: p.notConfigured,
    fallbackService: result.fallback.service,
    fallbackCid: f.cid,
    fallbackPinId: f.pinId,
    fallbackOk: f.ok,
    fallbackError: f.error,
    fallbackNotConfigured: f.notConfigured,
  };
  try {
    return await deps.repository.insert(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/attestation] recordPinReceipt: insert failed (cid=${row.cid}, agentId=${row.agentId}): ${msg.slice(0, 512)}`,
      err instanceof Error ? err : undefined,
      { cid: row.cid, agentId: row.agentId, hash: row.hash },
    );
  }
}
