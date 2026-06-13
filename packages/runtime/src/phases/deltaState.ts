/**
 * Predicted on-chain delta aggregated across the plan. Positive bigint =
 * INCREASE; negative = DECREASE. HF scaled 1e18 (Aave V3) to avoid float
 * drift in policy comparisons.
 */
export interface DeltaState {
  readonly healthFactorBefore: bigint;
  readonly healthFactorAfter: bigint;
  readonly balanceDeltas: Readonly<Record<string, bigint>>;
  readonly debtDeltas: Readonly<Record<string, bigint>>;
  readonly oracleChecks: { readonly stale: boolean };
}

/**
 * Per-action simulation result — DISCRIMINATED on `ok`. Illegal combos
 * (`ok:true` with revertReason, `ok:false` with no reason) are now
 * unrepresentable. `oracleStale` lives on BOTH variants because a stale
 * oracle is observable on either successful or reverted simulations and
 * the policy is "any stale poisons the tick" (ADR-008) regardless of ok.
 */
export type ActionSimResult =
  | {
      readonly ok: true;
      readonly gasUsed: bigint;
      readonly balanceDeltas: Readonly<Record<string, bigint>>;
      readonly debtDeltas: Readonly<Record<string, bigint>>;
      readonly healthFactorAfter: bigint;
      readonly oracleStale: boolean;
    }
  | {
      readonly ok: false;
      readonly gasUsed: bigint;
      readonly reason:
        | { readonly kind: 'revert'; readonly revertReason: string }
        | { readonly kind: 'oracle-stale' };
    };

export interface ComputeDeltaStateInput {
  readonly healthFactorBefore: bigint;
  readonly perAction: readonly ActionSimResult[];
}

/**
 * Pure aggregator: reduce per-action results into ONE DeltaState. HF
 * non-additive — we carry the LAST successful action's `healthFactorAfter`
 * because that's the predicted state after the full plan executes in order.
 * On the first failure, HF projection freezes at the prior success.
 * `oracleChecks.stale` ORs across all actions (ADR-008).
 */
/** Skip `__proto__`/`constructor`/`prototype` token keys (CWE-1321). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function computeDeltaState(input: ComputeDeltaStateInput): DeltaState {
  const balanceDeltas: Record<string, bigint> = Object.create(null);
  const debtDeltas: Record<string, bigint> = Object.create(null);
  let healthFactorAfter = input.healthFactorBefore;
  let oracleStale = false;

  for (const r of input.perAction) {
    if (r.ok) {
      for (const [token, delta] of Object.entries(r.balanceDeltas)) {
        if (FORBIDDEN_KEYS.has(token)) continue;
        balanceDeltas[token] = (balanceDeltas[token] ?? 0n) + delta;
      }
      for (const [token, delta] of Object.entries(r.debtDeltas)) {
        if (FORBIDDEN_KEYS.has(token)) continue;
        debtDeltas[token] = (debtDeltas[token] ?? 0n) + delta;
      }
      if (r.oracleStale) oracleStale = true;
      healthFactorAfter = r.healthFactorAfter;
    } else {
      if (r.reason.kind === 'oracle-stale') oracleStale = true;
      // Freeze HF + deltas at the failure point.
      break;
    }
  }

  return {
    healthFactorBefore: input.healthFactorBefore,
    healthFactorAfter,
    balanceDeltas: Object.freeze(balanceDeltas),
    debtDeltas: Object.freeze(debtDeltas),
    oracleChecks: Object.freeze({ stale: oracleStale }),
  };
}
