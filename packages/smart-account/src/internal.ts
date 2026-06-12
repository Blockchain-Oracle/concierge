import { ConciergeError } from '@concierge/sdk';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

const MAX_CAUSE_DEPTH = 10;

function buildPatterns(apiKey: string): readonly string[] {
  const encoded = encodeURIComponent(apiKey);
  return apiKey === encoded ? [apiKey] : [apiKey, encoded];
}

function redactString(value: string, patterns: readonly string[]): string {
  let out = value;
  for (const p of patterns) out = out.replaceAll(p, '[REDACTED]');
  return out;
}

function stringContainsAny(value: string, patterns: readonly string[]): boolean {
  for (const p of patterns) if (value.includes(p)) return true;
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function redactArrayElements(arr: unknown[], patterns: readonly string[]): unknown[] {
  return arr.map((v) => {
    if (typeof v === 'string')
      return stringContainsAny(v, patterns) ? redactString(v, patterns) : v;
    if (Array.isArray(v)) return redactArrayElements(v, patterns);
    if (isPlainObject(v)) return redactPlainObject(v, patterns);
    return v;
  });
}

function redactPlainObject(
  obj: Record<string, unknown>,
  patterns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string')
      out[k] = stringContainsAny(v, patterns) ? redactString(v, patterns) : v;
    else if (Array.isArray(v)) out[k] = redactArrayElements(v, patterns);
    else if (isPlainObject(v)) out[k] = redactPlainObject(v, patterns);
    else out[k] = v;
  }
  return out;
}

function arrayContainsAny(arr: unknown[], patterns: readonly string[]): boolean {
  for (const v of arr) {
    if (typeof v === 'string' && stringContainsAny(v, patterns)) return true;
    if (Array.isArray(v) && arrayContainsAny(v, patterns)) return true;
    if (isPlainObject(v) && plainObjectContainsAny(v, patterns)) return true;
  }
  return false;
}

function plainObjectContainsAny(
  obj: Record<string, unknown>,
  patterns: readonly string[],
): boolean {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && stringContainsAny(v, patterns)) return true;
    if (Array.isArray(v) && arrayContainsAny(v, patterns)) return true;
    if (isPlainObject(v) && plainObjectContainsAny(v, patterns)) return true;
  }
  return false;
}

function sanitizeStringProps(target: object, src: object, patterns: readonly string[]): void {
  for (const key of Object.getOwnPropertyNames(src)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    // biome-ignore lint/suspicious/noExplicitAny: walking unknown SDK error shapes
    const value = (src as any)[key];
    if (typeof value === 'string' && stringContainsAny(value, patterns)) {
      // biome-ignore lint/suspicious/noExplicitAny: target is the clone receiving redacted value
      (target as any)[key] = redactString(value, patterns);
    } else if (Array.isArray(value) && arrayContainsAny(value, patterns)) {
      // biome-ignore lint/suspicious/noExplicitAny: redacting array on clone
      (target as any)[key] = redactArrayElements(value, patterns);
    } else if (isPlainObject(value) && plainObjectContainsAny(value, patterns)) {
      // biome-ignore lint/suspicious/noExplicitAny: redacting nested POJO on clone
      (target as any)[key] = redactPlainObject(value, patterns);
    }
  }
}

function errorContainsAny(err: Error, patterns: readonly string[]): boolean {
  if (stringContainsAny(err.message, patterns)) return true;
  if (err.stack && stringContainsAny(err.stack, patterns)) return true;
  for (const key of Object.getOwnPropertyNames(err)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    // biome-ignore lint/suspicious/noExplicitAny: walking unknown SDK error shapes
    const value = (err as any)[key];
    if (typeof value === 'string' && stringContainsAny(value, patterns)) return true;
    if (Array.isArray(value) && arrayContainsAny(value, patterns)) return true;
    if (isPlainObject(value) && plainObjectContainsAny(value, patterns)) return true;
  }
  return false;
}

function valueContainsAnyDeep(
  v: unknown,
  patterns: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): boolean {
  // At cap: assume leak possible — forces sanitize pass to clone and apply sentinel.
  if (depth > MAX_CAUSE_DEPTH) return true;
  if (typeof v === 'string') return stringContainsAny(v, patterns);
  if (Array.isArray(v)) return arrayContainsAny(v, patterns);
  if (isPlainObject(v)) return plainObjectContainsAny(v, patterns);
  if (!(v instanceof Error)) return false;
  if (seen.has(v)) return false;
  seen.add(v);
  if (errorContainsAny(v, patterns)) return true;
  if (v.cause !== undefined && valueContainsAnyDeep(v.cause, patterns, seen, depth + 1))
    return true;
  if (v instanceof AggregateError && Array.isArray(v.errors)) {
    for (const e of v.errors) {
      if (valueContainsAnyDeep(e, patterns, seen, depth + 1)) return true;
    }
  }
  return false;
}

function sanitizeErrorDeep(
  err: Error,
  patterns: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): Error {
  if (seen.has(err)) return err;
  seen.add(err);
  const clone = Object.create(Object.getPrototypeOf(err)) as Error;
  Object.assign(clone, err);
  for (const key of Object.getOwnPropertyNames(err)) {
    if (key === 'message' || key === 'stack') continue;
    if (!Object.hasOwn(clone, key)) {
      const descriptor = Object.getOwnPropertyDescriptor(err, key);
      if (descriptor) Object.defineProperty(clone, key, descriptor);
    }
  }
  // Redact own message/stack/string props at EVERY depth (depth cap only stops further recursion)
  sanitizeStringProps(clone, err, patterns);
  Object.defineProperty(clone, 'message', {
    value: redactString(err.message, patterns),
    configurable: true,
    writable: true,
    enumerable: false,
  });
  if (err.stack) {
    Object.defineProperty(clone, 'stack', {
      value: redactString(err.stack, patterns),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  if (depth >= MAX_CAUSE_DEPTH) {
    // At cap: drop cause/errors to prevent unsanitized leak via further nesting.
    // biome-ignore lint/suspicious/noExplicitAny: defensive truncation marker
    (clone as any).cause = '[REDACTED: cause-chain depth exceeded]';
    if (err instanceof AggregateError && Array.isArray(err.errors)) {
      // biome-ignore lint/suspicious/noExplicitAny: depth-truncated AggregateError.errors
      (clone as any).errors = ['[REDACTED: cause-chain depth exceeded]'];
    }
    return clone;
  }
  if (err.cause !== undefined) {
    // biome-ignore lint/suspicious/noExplicitAny: cause is readonly unknown on Error; assigning sanitized form
    (clone as any).cause = sanitizeValue(err.cause, patterns, seen, depth + 1);
  }
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    // biome-ignore lint/suspicious/noExplicitAny: AggregateError.errors is non-enumerable own
    (clone as any).errors = err.errors.map((e: unknown) =>
      sanitizeValue(e, patterns, seen, depth + 1),
    );
  }
  return clone;
}

function sanitizeValue(
  err: unknown,
  patterns: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof err === 'string') {
    return stringContainsAny(err, patterns) ? redactString(err, patterns) : err;
  }
  if (Array.isArray(err)) {
    return arrayContainsAny(err, patterns) ? redactArrayElements(err, patterns) : err;
  }
  if (isPlainObject(err)) {
    return plainObjectContainsAny(err, patterns) ? redactPlainObject(err, patterns) : err;
  }
  if (err instanceof Error) {
    if (!valueContainsAnyDeep(err, patterns, new WeakSet(), 0)) return err;
    return sanitizeErrorDeep(err, patterns, seen, depth);
  }
  return err;
}

/**
 * Redacts apiKey (and its `encodeURIComponent` form) from an Error's message, stack,
 * own string properties + nested string[] / plain-object props (viem's `shortMessage`
 * / `details` / `metaMessages[]` / `request: { url }`), and the full `.cause` chain
 * (including non-Error POJO causes) while preserving prototype identity.
 *
 * Returns a clone when redaction fires; otherwise returns the input by reference.
 * Does NOT preserve reference identity on the redaction path — callers MUST NOT rely
 * on `sanitizeCause(e, k) === e`. Cycle-safe via WeakSet. At MAX_CAUSE_DEPTH the
 * cause/errors are replaced with a `[REDACTED: cause-chain depth exceeded]` sentinel
 * rather than silently leaking deeper unsanitized content.
 *
 * Empty apiKey is a no-op (avoids `replaceAll('', ...)` corruption).
 */
export function sanitizeCause(err: unknown, apiKey: string): unknown {
  if (!apiKey) return err;
  return sanitizeValue(err, buildPatterns(apiKey), new WeakSet(), 0);
}

/**
 * Redact apiKey + its `encodeURIComponent` form from an arbitrary string.
 * Use for sanitising response bodies / interpolated message fragments at construction time.
 * Empty apiKey is a no-op.
 */
export function redactApiKey(value: string, apiKey: string): string {
  if (!apiKey) return value;
  return redactString(value, buildPatterns(apiKey));
}

/**
 * Returns a .catch() callback that wraps any rejection as a sanitised RpcError.
 * `apiKey` is REQUIRED and must be non-empty — use `rpcCatchNoRedact` for the rare op
 * that has no secret in scope. Empty-string apiKey throws at construction to make the
 * silent-disabled-redaction footgun loud.
 * Note: catches ALL rejections including programmer errors (TypeError, RangeError) —
 * always inspect `.cause` when debugging unexpected RpcErrors.
 */
export function rpcCatch(op: string, chain: SupportedChain, apiKey: string) {
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] rpcCatch('${op}'): empty apiKey would silently disable redaction. Use rpcCatchNoRedact if no secret is in scope.`,
    );
  }
  return (err: unknown): never => {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] ${op} (chain: '${chain}')`,
      sanitizeCause(err, apiKey),
    );
  };
}

/**
 * Variant of rpcCatch for ops where no apiKey is in scope (no transport URL embedded).
 * Use sparingly — every call site is an audit checkpoint.
 */
export function rpcCatchNoRedact(op: string, chain: SupportedChain) {
  return (err: unknown): never => {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] ${op} (chain: '${chain}')`,
      err,
    );
  };
}

/** Validates chain + apiKey and returns the resolved config bundle. */
export function resolveChainConfig(
  callerName: string,
  chain: SupportedChain,
  apiKey: string | undefined,
): {
  chainConfig: (typeof CHAIN_CONFIGS)[keyof typeof CHAIN_CONFIGS];
  apiKey: string;
  bundlerUrl: string;
} {
  const chainConfig = CHAIN_CONFIGS[chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] ${callerName}: UnsupportedChain('${chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] ${callerName}: MissingEnvVar('PIMLICO_API_KEY') — set this env var or pass apiKey in config.`,
    );
  }
  return {
    chainConfig,
    apiKey,
    bundlerUrl: `${chainConfig.bundlerBaseUrl}?apikey=${encodeURIComponent(apiKey)}`,
  };
}
