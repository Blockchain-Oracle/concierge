import Anthropic from '@anthropic-ai/sdk';
import { ConciergeError } from '@concierge/sdk';

/**
 * Anthropic prompt-caching beta header. Anthropic accepts unknown beta
 * tokens silently (fails-open into "no caching") — rotation is a cost
 * regression, not a 4xx.
 */
export const PROMPT_CACHING_BETA = 'prompt-caching-2024-07-31';

/** Headers Anthropic OWNS — callers MUST NOT supply these via defaultHeaders. */
const RESERVED_HEADER_KEYS = Object.freeze([
  'x-api-key',
  'authorization',
  'anthropic-version',
] as const);

/** Loopback / RFC1918 / link-local / ULA — never legitimate Anthropic endpoints. */
const PRIVATE_HOSTNAMES = Object.freeze(['localhost', '0.0.0.0', '::', '::1'] as const);

/** Token-charset per RFC 7230 §3.2.6 — visible ASCII minus separators. */
const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Header value charset — printable ASCII + HTAB; rejects CR/LF/NUL injection. */
const HEADER_VALUE_RE = /^[\t\x20-\x7e]*$/;

const MAX_BETA_HEADER_LENGTH = 4096;
const MAX_BETA_TOKEN_COUNT = 32;

export interface CreateLlmClientConfig {
  /** Anthropic API key. Required; throws ConfigError on empty/missing/whitespace. */
  readonly apiKey: string;
  /**
   * Optional API base URL override. MUST be `https:`. By default rejects
   * loopback / private / link-local hosts and non-443 ports (CWE-918 defense).
   * Pass `allowPrivateBaseURL: true` for local proxies / test setups.
   */
  readonly baseURL?: string;
  /** Opt-out for the private-host + port guards. Use ONLY for trusted local setups. */
  readonly allowPrivateBaseURL?: boolean;
  /** Optional extra default headers. Reserved-key + ASCII-token validation applied. */
  readonly defaultHeaders?: Record<string, string>;
}

/**
 * Pure beta-header merge. Caller's existing betas come FIRST (preserves
 * order-sensitive gating); PROMPT_CACHING_BETA appended only if not already
 * present (case-insensitive). Rejects CRLF / control chars / non-ASCII tokens
 * to block header injection (CWE-93).
 *
 * Empty / whitespace-only / all-comma input collapses to just PROMPT_CACHING_BETA.
 */
export function mergeBetaHeader(callerValue: string | undefined): string {
  const raw = callerValue ?? '';
  if (raw.length > MAX_BETA_HEADER_LENGTH) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] mergeBetaHeader: value exceeds ${MAX_BETA_HEADER_LENGTH} chars.`,
    );
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length > MAX_BETA_TOKEN_COUNT) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] mergeBetaHeader: too many beta tokens (${parts.length} > ${MAX_BETA_TOKEN_COUNT}).`,
    );
  }
  for (const p of parts) {
    if (!HEADER_TOKEN_RE.test(p)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/llm] mergeBetaHeader: token contains forbidden chars (CRLF / control / non-ASCII).`,
      );
    }
  }
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  if (!seen.has(PROMPT_CACHING_BETA)) parts.push(PROMPT_CACHING_BETA);
  return parts.join(',');
}

function assertHeadersAllowed(headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    const kLower = k.toLowerCase();
    if ((RESERVED_HEADER_KEYS as readonly string[]).includes(kLower)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/llm] createLlmClient: defaultHeaders may not contain reserved key '${k}' (RESERVED_HEADER_KEYS: ${RESERVED_HEADER_KEYS.join(', ')}).`,
      );
    }
    if (!HEADER_TOKEN_RE.test(k)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/llm] createLlmClient: header key '${k}' contains forbidden chars (must be RFC 7230 token).`,
      );
    }
    if (!HEADER_VALUE_RE.test(v)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/llm] createLlmClient: header value for '${k}' contains forbidden chars (CRLF / control / non-ASCII).`,
      );
    }
  }
}

function isPrivateOrLoopbackIPv4(host: string): boolean {
  // Literal-IP form only — DNS-rebinding is out of scope (needs connect-time pinning).
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return true; // malformed → treat as suspect
  if (a === 127) return true; // 127/8 loopback
  if (a === 10) return true; // 10/8 RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168/16 RFC1918
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 0) return true; // 0/8 reserved
  return false;
}

function assertBaseURL(baseURL: string, allowPrivate: boolean): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] createLlmClient: baseURL is not a valid URL.`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] createLlmClient: baseURL must use https: (got '${url.protocol}').`,
    );
  }
  if (allowPrivate) return;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    (PRIVATE_HOSTNAMES as readonly string[]).includes(host) ||
    host.startsWith('fe80:') || // IPv6 link-local
    host.startsWith('fc') || // IPv6 ULA fc00::/7 (matches fc/fd)
    host.startsWith('fd') ||
    isPrivateOrLoopbackIPv4(host)
  ) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] createLlmClient: baseURL host '${url.hostname}' is loopback/private/link-local. Pass allowPrivateBaseURL: true to override.`,
    );
  }
  if (url.port !== '' && url.port !== '443') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] createLlmClient: baseURL port '${url.port}' is not 443. Pass allowPrivateBaseURL: true to override.`,
    );
  }
}

/**
 * Constructs an Anthropic SDK client with prompt-caching enabled and
 * caller-supplied auth/inject-able headers rejected.
 */
export function createLlmClient(config: CreateLlmClientConfig): Anthropic {
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/llm] createLlmClient: apiKey is required (set ANTHROPIC_API_KEY).`,
    );
  }
  if (config.baseURL !== undefined) {
    assertBaseURL(config.baseURL, config.allowPrivateBaseURL === true);
  }
  const callerHeaders = config.defaultHeaders ?? {};
  assertHeadersAllowed(callerHeaders);
  const mergedBeta = mergeBetaHeader(callerHeaders['anthropic-beta']);
  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL !== undefined && { baseURL: config.baseURL }),
    defaultHeaders: {
      ...callerHeaders,
      'anthropic-beta': mergedBeta,
    },
  });
}
