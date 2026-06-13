/**
 * Comprehensive error sanitizer. Mirrors story-60's sanitize.ts coverage so
 * the two packages can't drift. Covers (in order of priority):
 *
 *   1. Query-string params: ?apikey=… ?key=… ?token=… ?secret=…
 *   2. Basic-auth URLs:     https://user:pass@host
 *   3. Path-segment keys:   /v2/<key>, /v3/<key>, /rpc/<key> (Alchemy/Infura/Pimlico)
 *   4. Bearer / header echoes: Authorization: Bearer <token>, x-api-key: <token>
 *   5. JSON body fields:    "apiKey":"…", "token":"…"
 *
 * Each regex is conservative — must not eat tx hashes (0x… of 66), addresses
 * (40-hex), or normal log payloads. The cause chain is walked recursively
 * (bounded depth) so a downstream serializer that follows `.cause` (Sentry,
 * pino's `err` serializer, BullMQ failed-job records) sees a fully-scrubbed
 * chain. Round-1 missed this and left the side door open.
 */

const QUERY_PARAM_RE = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"'<>]+/gi;
const BASIC_AUTH_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi;
const PATH_KEY_RE = /(\/(?:v[1-9]|rpc)\/)[A-Za-z0-9_-]{16,}(?=\/|$|\?|\s|"|'|<|>)/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const HEADER_KEY_RE = /((?:x-api-key|x-auth-token|authorization)\s*[:=]\s*)\S{8,}/gi;
const JSON_KEY_RE = /("(?:api[_-]?key|token|secret)"\s*:\s*")[^"]+(")/gi;

const MAX_CAUSE_DEPTH = 6;

export function sanitizeMessage(input: string): string {
  return input
    .replace(QUERY_PARAM_RE, '$1<redacted>')
    .replace(BASIC_AUTH_RE, '$1<redacted>@')
    .replace(PATH_KEY_RE, '$1<redacted>')
    .replace(BEARER_RE, '$1<redacted>')
    .replace(HEADER_KEY_RE, '$1<redacted>')
    .replace(JSON_KEY_RE, '$1<redacted>$2');
}

/**
 * Builds a fresh Error with sanitized message AND stack, with the cause chain
 * recursively sanitized. NEVER returns the original Error reference — so a
 * downstream walker that hits `.cause.message` or `.cause.stack` sees only
 * scrubbed text. Cycle-safe via depth bound.
 */
export function sanitizeError(err: unknown, depth = 0): Error {
  if (depth > MAX_CAUSE_DEPTH) return new Error('<cause chain truncated>');
  if (err instanceof Error) {
    let sanitized: Error;
    try {
      const msg = sanitizeMessage(err.message);
      const cause = err.cause !== undefined ? sanitizeError(err.cause, depth + 1) : undefined;
      sanitized = new Error(msg, cause !== undefined ? { cause } : undefined);
      sanitized.name = err.name;
      if (err.stack) sanitized.stack = sanitizeMessage(err.stack);
    } catch {
      // If the caller installed a getter that throws (or .message access
      // throws), fail-safe to a generic redacted error — the orchestrator
      // boundary must NEVER throw out of sanitize.
      sanitized = new Error('<sanitize failed>');
    }
    return sanitized;
  }
  try {
    return new Error(sanitizeMessage(String(err)));
  } catch {
    return new Error('<sanitize failed>');
  }
}
