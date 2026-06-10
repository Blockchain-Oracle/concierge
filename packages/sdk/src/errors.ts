/**
 * Discriminator values for every error the Concierge SDK surfaces, per
 * ADR-019. `EModeNotEnabled` exists because Aave's `Pool.borrow()` returns 0
 * SILENTLY for sUSDe collateral outside E-Mode 1 — the SDK turns that silent
 * failure into a loud, typed one.
 *
 * Exported as a runtime list (the union is derived from it) so plain-JS
 * callers — who don't get the compile-time union — can validate and so the
 * constructor can reject typo'd types loudly instead of letting a
 * `switch (err.type)` silently match no case.
 */
export const CONCIERGE_ERROR_TYPES = [
  'EModeNotEnabled',
  'InsufficientLiquidity',
  'OracleUnavailable',
  'AttestationFailed',
  'UserRejected',
  'NetworkUnsupported',
  'RpcError',
] as const;

export type ConciergeErrorType = (typeof CONCIERGE_ERROR_TYPES)[number];

/**
 * Single error base class with a `type` discriminator (the Stripe
 * `err.type` + Anthropic status-class blend, per ADR-019 / SDK-DX-STUDY §F):
 * `instanceof ConciergeError` to detect, `switch (err.type)` to handle.
 *
 * `cause` is forwarded through native `ErrorOptions` rather than stored as a
 * class field, preserving native semantics: it is installed only when
 * provided (`'cause' in err` is false otherwise) and non-enumerable, so
 * `JSON.stringify(err)` never leaks the raw cause (a viem revert can carry
 * calldata / RPC URLs).
 */
export class ConciergeError extends Error {
  override readonly name = 'ConciergeError';

  constructor(
    public readonly type: ConciergeErrorType,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    if (!CONCIERGE_ERROR_TYPES.includes(type)) {
      throw new TypeError(
        `[@concierge/sdk] ConciergeError: unknown type "${String(type)}" — expected one of: ${CONCIERGE_ERROR_TYPES.join(', ')}.`,
      );
    }
  }
}
