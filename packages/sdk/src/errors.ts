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

/**
 * Narrows arbitrary values (env strings, JSON payloads) to the type union without casts.
 * The `as readonly unknown[]` cast is required because TS's `Array.includes` only accepts
 * the element type — `string[]` rejects `unknown`. This is a known TS limitation; the cast
 * is safe here because the array is frozen `as const`.
 */
export function isConciergeErrorType(value: unknown): value is ConciergeErrorType {
  return (CONCIERGE_ERROR_TYPES as readonly unknown[]).includes(value);
}

/**
 * Single error base class with a `type` discriminator (the Stripe
 * `err.type` + Anthropic status-class blend, per ADR-019 / SDK-DX-STUDY §F):
 * `instanceof ConciergeError` to detect, `switch (err.type)` to handle.
 *
 * `cause` is forwarded through native `ErrorOptions` (non-enumerable, so
 * `JSON.stringify(err)` never leaks raw RPC payloads); falsy-but-defined
 * causes (`null`, `0`, `''`) ARE installed. One deliberate divergence from
 * native: an explicit `new ConciergeError(t, m, undefined)` is treated as
 * omitted, whereas native `new Error(m, { cause: undefined })` installs an
 * own `cause: undefined`.
 *
 * Property descriptor strategy: `type` and `name` are sealed via
 * `Object.defineProperty` in the constructor (not class field initializers)
 * so their descriptors can be precisely controlled. `type` is enumerable
 * (shows in `JSON.stringify` — the discriminator must survive log serialization).
 * `name` is non-enumerable (matches native `Error.prototype.name` semantics).
 */
export class ConciergeError extends Error {
  // `declare` is type-only — no class-field initializer is emitted.
  // The actual value is set by defineProperty in the constructor so we
  // can control enumerable (false) and configurable (false) precisely.
  declare readonly name: 'ConciergeError';

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
    // Seal `type`: TS `readonly` is compile-time only. `configurable: false`
    // too — otherwise `Object.defineProperty(err, 'type', { value: 'X' })`
    // would still slip past a non-writable slot. `type` stays enumerable so
    // it appears in JSON.stringify output (log consumers need the discriminator).
    Object.defineProperty(this, 'type', { writable: false, configurable: false });
    // Seal `name`: the class-field initializer would create a writable,
    // configurable, enumerable own property — inconsistent with native
    // Error.prototype.name (which lives on the prototype, non-enumerable).
    // Setting enumerable:false keeps JSON.stringify(err) clean.
    Object.defineProperty(this, 'name', {
      value: 'ConciergeError',
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
}
