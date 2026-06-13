import { z } from 'zod';

export const EXECUTE_OUTCOMES = [
  'confirmed',
  'tx_reverted',
  'timeout',
  'session_key_expired',
  'awaiting_user_signature',
] as const;
export type ExecuteOutcomeKind = (typeof EXECUTE_OUTCOMES)[number];

import { hash32Schema } from './hash.ts';

export const executionRowSchema = z.object({
  proposalId: z.string().min(1),
  agentId: z.string().min(1),
  userOpHash: hash32Schema.optional(),
  txHash: hash32Schema.optional(),
  blockNumber: z.bigint().nonnegative().optional(),
  gasUsedActual: z.bigint().nonnegative().optional(),
  status: z.enum(EXECUTE_OUTCOMES),
  revertReason: z.string().max(4096).optional(),
  gasEstimateDriftPct: z.number().finite().optional(),
});
export type ExecutionRow = z.infer<typeof executionRowSchema>;

/** Outcome returned to the orchestrator. Discriminated on `status`. */
export type ExecuteOutcome =
  | {
      readonly status: 'confirmed';
      readonly executionId: string;
      readonly userOpHash: string;
      readonly txHash: string;
      readonly blockNumber: bigint;
      readonly gasUsedActual: bigint;
      readonly gasEstimateDriftPct: number;
    }
  | {
      readonly status: 'tx_reverted';
      readonly executionId: string;
      readonly userOpHash: string;
      readonly txHash: string;
      readonly blockNumber: bigint;
      readonly revertReason: string;
    }
  | {
      readonly status: 'timeout';
      readonly executionId: string;
      readonly userOpHash: string;
    }
  | { readonly status: 'session_key_expired'; readonly executionId: string }
  | {
      readonly status: 'awaiting_user_signature';
      readonly executionId: string;
      readonly queueId: string;
    };

/**
 * Compile-time bidirectional check: the literal-union members of
 * `ExecuteOutcomeKind` and `ExecuteOutcome['status']` must stay in lockstep.
 * Adding a 6th outcome to one but not the other fails to typecheck here.
 */
type _OutcomeKindMatch = ExecuteOutcome['status'] extends ExecuteOutcomeKind
  ? ExecuteOutcomeKind extends ExecuteOutcome['status']
    ? true
    : false
  : false;
const _outcomeKindCheck: _OutcomeKindMatch = true;
void _outcomeKindCheck;
