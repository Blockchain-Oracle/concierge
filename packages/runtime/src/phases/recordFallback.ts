import type { PhaseOutcome } from '../types.ts';
import {
  type ConfirmedExecution,
  type RunRecordDeps,
  type RunRecordInputs,
  runRecord,
} from './record.ts';
import type { RecordOutcome } from './recordSchema.ts';

/**
 * EOA-fallback record path. The user-signed tx confirms out-of-tick (per
 * story-55 sender.ts); the worker calls runRecordFallback with the confirmed
 * receipt. Architecture allows both signing paths to fire the same
 * attestation chain — the only difference is the timing source, not the
 * record logic.
 *
 * This is a thin wrapper today, but kept as its own export so the worker can
 * route on signing-path without re-deriving the call shape. Future divergence
 * (e.g., EOA-specific attestation schema) lives here, not inside runRecord.
 */
export function runRecordFallback(
  inputs: RunRecordInputs & { readonly exec: ConfirmedExecution },
  deps: RunRecordDeps,
): Promise<PhaseOutcome<RecordOutcome>> {
  return runRecord(inputs, deps);
}
