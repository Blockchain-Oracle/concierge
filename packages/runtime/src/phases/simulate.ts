import { ConciergeError } from '@concierge/sdk';
import { sanitizeError, sanitizeMessage } from '../sanitize.ts';
import type { AgentState, PhaseOutcome, Plan, Sim } from '../types.ts';
import { type ActionSimResult, computeDeltaState, type DeltaState } from './deltaState.ts';

const IDENT_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_REVERT_REASON_LEN = 4096;
const DEFAULT_HF_FLOOR = 1_500_000_000_000_000_000n; // 1.5e18
const DEFAULT_BLOCK_GAS_LIMIT = 30_000_000n;
const CUMULATIVE_GAS_BOUND_MULTIPLIER = 10n;
const NEVER_ABORT = new AbortController().signal;

/** Template-literal-typed registry key. Catches typos at the registry build site. */
export type ProviderActionKey = `${string}:${string}`;
export const providerActionKey = (provider: string, action: string): ProviderActionKey =>
  `${provider}:${action}`;

export type ActionSimulator = (
  preState: AgentState,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) => Promise<ActionSimResult>;

export type SimulatorRegistry = ReadonlyMap<ProviderActionKey, ActionSimulator>;

/**
 * Discriminated SimError union. Each kind drives a distinct operator response
 * policy. `revert` retries with adjusted args; `oracle-stale` waits; `hf-breach`
 * tightens; `unknown-action` is a wiring bug; `aborted` means the tick budget
 * elapsed; `gas-overrun` and `plan-gas-overrun` are infra-side bounds.
 */
export type SimError =
  | {
      readonly kind: 'revert';
      readonly failedAtIndex: number;
      readonly provider: string;
      readonly action: string;
      readonly revertReason: string;
    }
  | {
      readonly kind: 'oracle-stale';
      readonly failedAtIndex: number;
      readonly provider: string;
      readonly action: string;
    }
  | { readonly kind: 'hf-breach'; readonly healthFactorAfter: bigint; readonly floor: bigint }
  | { readonly kind: 'unknown-action'; readonly provider: string; readonly action: string }
  | {
      readonly kind: 'gas-overrun';
      readonly failedAtIndex: number;
      readonly gasUsed: bigint;
      readonly blockGasLimit: bigint;
    }
  | {
      readonly kind: 'plan-gas-overrun';
      readonly totalGas: bigint;
      readonly bound: bigint;
    }
  | {
      readonly kind: 'aborted';
      readonly failedAtIndex: number;
      readonly provider?: string;
      readonly action?: string;
    };

export interface RunSimulateInputs {
  readonly preState: AgentState;
  readonly plan: Plan;
  readonly registry: SimulatorRegistry;
  readonly healthFactorBefore: bigint;
}

export interface RunSimulateOptions {
  readonly healthFactorFloor?: bigint;
  readonly blockGasLimit?: bigint;
  readonly abortSignal?: AbortSignal;
}

/**
 * DetailedSim couples `error` to `ok` so a `false` ok cannot exist without a
 * cause and `true` ok cannot carry one. The doc-only invariant from round-1
 * is now a type-level invariant.
 *
 * `expectedValueDeltaUsd: null` is the EXPLICIT "not yet priced" signal —
 * story-65 (propose) replaces with a number. `0` is a valid trade outcome
 * (break-even) so we cannot use it as a sentinel.
 */
type SimBase = Omit<Sim, 'ok' | 'expectedValueDeltaUsd'> & {
  readonly expectedValueDeltaUsd: number | null;
};
export type DetailedSim = SimBase &
  (
    | { readonly ok: true; readonly deltaState: DeltaState; readonly error?: never }
    | { readonly ok: false; readonly deltaState: DeltaState; readonly error: SimError }
  );

/**
 * Sanitize a free-form string before it lands in logs or the SimError envelope.
 * Bounds length BEFORE running the regex chain to avoid CPU DoS on a misbehaving
 * simulator that returns a multi-MB string.
 */
function sanitizeReason(input: string): string {
  return sanitizeError(input.slice(0, MAX_REVERT_REASON_LEN)).message;
}

/** Run simulator races against signal abort so a stuck simulator can't outrun the tick budget. */
async function raceAgainstAbort<T>(worker: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('aborted');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Simulate the plan's actions in order. Domain failures RETURNED (caller sees
 * ok:false + error); INFRA failures (simulator crash, invariant violation)
 * THROWN as ConciergeError.
 */
export async function runSimulate(
  inputs: RunSimulateInputs,
  options: RunSimulateOptions = {},
): Promise<PhaseOutcome<DetailedSim>> {
  const floor = options.healthFactorFloor ?? DEFAULT_HF_FLOOR;
  const blockGasLimit = options.blockGasLimit ?? DEFAULT_BLOCK_GAS_LIMIT;
  const cumulativeBound = blockGasLimit * CUMULATIVE_GAS_BOUND_MULTIPLIER;
  const signal = options.abortSignal ?? NEVER_ABORT;

  const perAction: ActionSimResult[] = [];
  let totalGas = 0n;
  let error: SimError | undefined;

  for (const [i, call] of inputs.plan.providerCalls.entries()) {
    // Defense-in-depth: a future non-runPlan plan ingress (story-300+) could
    // bypass the Zod IDENT_RE gate. Re-assert at the boundary so the registry
    // key construction can't be coerced.
    if (!IDENT_RE.test(call.provider) || !IDENT_RE.test(call.action)) {
      throw new ConciergeError(
        'InvariantViolation',
        `[@concierge/runtime] runSimulate: provider/action must match ${IDENT_RE.source} at index ${i}.`,
      );
    }
    const safeProvider = sanitizeMessage(call.provider);
    const safeAction = sanitizeMessage(call.action);

    if (signal.aborted) {
      error = { kind: 'aborted', failedAtIndex: i, provider: safeProvider, action: safeAction };
      break;
    }

    const key = providerActionKey(call.provider, call.action);
    const simulator = inputs.registry.get(key);
    if (!simulator) {
      error = { kind: 'unknown-action', provider: safeProvider, action: safeAction };
      break;
    }

    // Defense-in-depth against future non-Zod ingresses (CWE-1321): null-proto
    // a shallow copy so a downstream simulator that does `{ ...args }` can't
    // resurrect prototype pollution from a malicious args bag.
    const safeArgs: Readonly<Record<string, unknown>> = Object.assign(
      Object.create(null),
      call.args ?? {},
    );

    let result: ActionSimResult;
    try {
      result = await raceAgainstAbort(simulator(inputs.preState, safeArgs, signal), signal);
    } catch (err) {
      // Distinguish "we aborted" from "simulator threw infra error".
      if (signal.aborted) {
        error = { kind: 'aborted', failedAtIndex: i, provider: safeProvider, action: safeAction };
        break;
      }
      throw new ConciergeError(
        'RpcError',
        `[@concierge/runtime] runSimulate: simulator '${key}' threw: ${sanitizeError(err).message}`,
        sanitizeError(err),
        { failedAtIndex: i, provider: safeProvider, action: safeAction },
      );
    }
    perAction.push(result);
    totalGas += result.gasUsed;

    // ADR-008: stale oracle poisons the tick regardless of ok. Check FIRST.
    const isStale = result.ok ? result.oracleStale : result.reason.kind === 'oracle-stale';
    if (isStale) {
      error = {
        kind: 'oracle-stale',
        failedAtIndex: i,
        provider: safeProvider,
        action: safeAction,
      };
      break;
    }

    if (!result.ok) {
      // Oracle-stale was handled above; narrow the union to revert here.
      if (result.reason.kind !== 'revert') {
        throw new ConciergeError(
          'InvariantViolation',
          `[@concierge/runtime] runSimulate: unhandled failure kind '${result.reason.kind}'.`,
        );
      }
      error = {
        kind: 'revert',
        failedAtIndex: i,
        provider: safeProvider,
        action: safeAction,
        revertReason: sanitizeReason(result.reason.revertReason),
      };
      break;
    }

    if (result.gasUsed > blockGasLimit) {
      error = {
        kind: 'gas-overrun',
        failedAtIndex: i,
        gasUsed: result.gasUsed,
        blockGasLimit,
      };
      break;
    }
  }

  // Cumulative gas bound — a malformed simulator returning many sub-block-limit
  // gas estimates could still sum to an absurd total (CWE-1284).
  if (error === undefined && totalGas > cumulativeBound) {
    error = { kind: 'plan-gas-overrun', totalGas, bound: cumulativeBound };
  }

  const deltaState = computeDeltaState({
    healthFactorBefore: inputs.healthFactorBefore,
    perAction,
  });

  // HF floor check runs LAST — precedence note: gas/revert/oracle errors
  // surface first because they mean "tx won't even land", whereas hf-breach
  // means "tx lands but unsafe to user".
  if (error === undefined && deltaState.healthFactorAfter < floor) {
    error = { kind: 'hf-breach', healthFactorAfter: deltaState.healthFactorAfter, floor };
  }

  const ok = error === undefined;
  const warnings: string[] = [];
  if (deltaState.oracleChecks.stale) warnings.push('oracle-stale-detected');

  const sim: DetailedSim = ok
    ? {
        ok: true,
        gasEstimateWei: totalGas,
        expectedValueDeltaUsd: null,
        warnings,
        deltaState,
      }
    : {
        ok: false,
        gasEstimateWei: totalGas,
        expectedValueDeltaUsd: null,
        warnings,
        deltaState,
        error: error as SimError,
      };
  return { kind: 'continue', data: sim };
}
