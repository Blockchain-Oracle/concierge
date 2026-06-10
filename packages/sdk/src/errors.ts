/**
 * Discriminator values for every error the Concierge SDK surfaces, per
 * ADR-019. `EModeNotEnabled` exists because Aave's `Pool.borrow()` returns 0
 * SILENTLY for sUSDe collateral outside E-Mode 1 — the SDK turns that silent
 * failure into a loud, typed one.
 *
 * `ConfigError` covers startup / env-var validation failures (story-23 / story-24).
 * Story-23 specced a full class hierarchy with `code` property (pre-rework design);
 * ADR-019 (2026-06-09) chose a single base class + `type` discriminator instead.
 * Only `ConfigError` survives as a subclass because story-24 needs `instanceof`
 * detection at config-load time, before a `switch (err.type)` handler is wired up.
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
  'ConfigError',
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
 * `metadata` is optional structured context for telemetry (e.g. Zod issues
 * from config validation, or DeFi call parameters). It IS enumerable so it
 * surfaces in `JSON.stringify` output — unlike `cause`, metadata is safe for
 * logs (callers must not put secrets in it).
 *
 * Property descriptor strategy: `type` and `name` are sealed via
 * `Object.defineProperty` in the constructor (not class field initializers)
 * so their descriptors can be precisely controlled. `type` is enumerable
 * (shows in `JSON.stringify` — the discriminator must survive log serialization).
 * `name` is non-enumerable (matches native `Error.prototype.name` semantics).
 * Subclasses inherit `name === 'ConciergeError'` — the `type` discriminator
 * is the primary identifier, consistent with the ADR-019 Stripe/Anthropic blend.
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
  // `declare` prevents the class-field initializer from emitting `metadata: undefined`
  // as an own property when the arg is omitted — `'metadata' in err` should be false
  // when no metadata was provided, matching the `cause` pattern.
  declare readonly metadata?: Record<string, unknown>;

  constructor(
    type: ConciergeErrorType,
    message: string,
    cause?: unknown,
    metadata?: Record<string, unknown>,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    if (!isConciergeErrorType(type)) {
      throw new TypeError(
        `[@concierge/sdk] ConciergeError: unknown type "${String(type)}" — expected one of: ${CONCIERGE_ERROR_TYPES.join(', ')}.`,
      );
    }
    this.type = type;
    // Seal `metadata` with the same descriptor strategy as `type`: TS `readonly`
    // is compile-time only. `configurable: false` prevents `defineProperty`
    // bypass; `enumerable: true` keeps it visible in JSON.stringify output.
    if (metadata !== undefined) {
      Object.defineProperty(this, 'metadata', {
        value: metadata,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    }
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

  /**
   * Wraps any caught value as a `ConciergeError` without double-wrapping.
   * Use in `catch` blocks where the error type is unknown (e.g. viem reverts,
   * third-party SDK throws). Defaults to `type: 'RpcError'` since most
   * unexpected throws in the hot path are RPC-layer failures.
   */
  static fromUnknown(error: unknown, type: ConciergeErrorType = 'RpcError'): ConciergeError {
    if (error instanceof ConciergeError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new ConciergeError(type, message, error);
  }

  /**
   * Returns a plain object safe for structured logging and JSON.stringify.
   * `cause` is intentionally omitted — it may carry raw calldata / RPC URLs.
   * `metadata` is included and BigInt-sanitised: viem amounts are bigint, and
   * `JSON.stringify(bigint)` throws. BigInts are converted to decimal strings
   * so `JSON.stringify(err.toJSON())` never throws on real DeFi metadata.
   */
  toJSON(): Record<string, unknown> {
    // `name` is non-enumerable on purpose (matches native Error semantics);
    // omitting it here keeps JSON.stringify(err) clean for log consumers.
    const result: Record<string, unknown> = {
      type: this.type,
      message: this.message,
    };
    if (this.metadata !== undefined) {
      try {
        result['metadata'] = JSON.parse(
          JSON.stringify(this.metadata, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
        );
      } catch (serializationErr) {
        // A secondary throw from toJSON() is catastrophic in error-reporting paths.
        // Log it so the bug is traceable, then fall back to a safe placeholder.
        console.error(
          `[@concierge/sdk] ConciergeError.toJSON: failed to serialize metadata for type "${this.type}":`,
          serializationErr,
        );
        result['metadata'] = '[unserializable metadata]';
      }
    }
    return result;
  }
}

/**
 * Structured metadata carried by `ConfigError`. Typed explicitly so callers
 * can access `err.metadata.issues` without a cast or type guard — the compiler
 * enforces that the key exists and is the correct Zod shape.
 */
export interface ConfigErrorMetadata extends Record<string, unknown> {
  issues: import('zod').ZodIssue[];
}

/**
 * Thrown by `loadConfig()` when required env vars are missing or invalid.
 * Extends `ConciergeError` so handlers can use `instanceof ConfigError` for
 * startup checks, and `err.type === 'ConfigError'` for `switch`-based handling.
 * `metadata` carries the Zod validation issues for structured error reporting.
 *
 * Pre-rework story-23 called this `code: 'CONCIERGE_CONFIG_ERROR'`; ADR-019
 * uses `type` as the discriminator, so `err.type === 'ConfigError'` is correct.
 */
export class ConfigError extends ConciergeError {
  // Narrows the inherited `metadata?: Record<string, unknown>` to the concrete
  // Zod-issues shape. `declare` is type-only — no class-field initializer emitted.
  declare readonly metadata?: ConfigErrorMetadata;

  constructor(message: string, metadata?: ConfigErrorMetadata, cause?: unknown) {
    super('ConfigError', message, cause, metadata);
  }
}
