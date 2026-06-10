/**
 * Discriminator values for every error the Concierge SDK surfaces, per
 * ADR-019. `EModeNotEnabled` exists because Aave's `Pool.borrow()` returns 0
 * SILENTLY for sUSDe collateral outside E-Mode 1 — the SDK turns that silent
 * failure into a loud, typed one.
 *
 * Exported as a runtime list (the union is derived from it) so plain-JS
 * callers — who don't get the compile-time union — can validate and so the
 * constructor can reject typo'd types loudly instead of letting a
 * `switch (err.type)` silently match no case. Frozen because the list IS the
 * constructor's runtime guard: `as const` is compile-time only, and an
 * unfrozen array would let any consumer `push('Whatever')` and silently
 * widen the guard for every later construction.
 */
export const CONCIERGE_ERROR_TYPES = Object.freeze([
  'EModeNotEnabled',
  'InsufficientLiquidity',
  'OracleUnavailable',
  'AttestationFailed',
  'UserRejected',
  'NetworkUnsupported',
  'RpcError',
] as const);

export type ConciergeErrorType = (typeof CONCIERGE_ERROR_TYPES)[number];

/** Narrows arbitrary values (env strings, JSON payloads) to the type union without casts. */
export function isConciergeErrorType(value: unknown): value is ConciergeErrorType {
  return (CONCIERGE_ERROR_TYPES as readonly unknown[]).includes(value);
}

/**
 * Single error base class with a `type` discriminator (the Stripe
 * `err.type` + Anthropic status-class blend, per ADR-019 / SDK-DX-STUDY §F):
 * `instanceof ConciergeError` to detect, `switch (err.type)` to handle.
 *
 * `cause` is forwarded through native `ErrorOptions` rather than stored as a
 * class field, near-preserving native semantics: it is installed only when
 * provided and defined (`'cause' in err` is false otherwise) and
 * non-enumerable, so `JSON.stringify(err)` never leaks the raw cause (a viem
 * revert can carry calldata / RPC URLs). Falsy-but-defined causes (`null`,
 * `0`, `''`) ARE installed — the discriminator is `=== undefined`, not
 * truthiness. One deliberate divergence from native: an explicit
 * `new ConciergeError(t, m, undefined)` is treated as omitted, whereas
 * native `new Error(m, { cause: undefined })` installs an own
 * `cause: undefined`.
 */
export class ConciergeError extends Error {
  override readonly name = 'ConciergeError';

  // ErrorOptions installs `cause` at runtime; `declare` surfaces it on the
  // type without emitting an enumerable class field that would shadow it.
  declare readonly cause?: unknown;

  readonly type: ConciergeErrorType;

  constructor(type: ConciergeErrorType, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    if (!isConciergeErrorType(type)) {
      throw new TypeError(
        `[@concierge/sdk] ConciergeError: unknown type "${String(type)}" — expected one of: ${CONCIERGE_ERROR_TYPES.join(', ')}.`,
      );
    }
    this.type = type;
    // TS `readonly` is compile-time only; without this a JS caller could
    // reassign `err.type` after construction and bypass the guard above.
    Object.defineProperty(this, 'type', { writable: false });
  }
}
