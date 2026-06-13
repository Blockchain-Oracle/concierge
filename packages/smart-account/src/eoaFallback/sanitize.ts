/**
 * Centralized scrubber for RPC/bundler error messages before they hit the DB
 * or stderr logs. Real-world leak shapes covered (post-merge round-2):
 *
 *   1. Query-string params:  ?apikey=... ?key=... ?token=... ?secret=...
 *   2. Basic-auth URLs:      https://user:pass@host
 *   3. Path-segment keys:    /v2/<key>, /v3/<key>, /rpc/<key>  (Alchemy / Infura / Pimlico)
 *   4. Header echoes:        Authorization: Bearer <token>, x-api-key: <token>
 *
 * Each regex is conservative — it must not eat tx hashes (0x… of 66 chars),
 * contract addresses (40-hex), or normal log payloads. We err on the side of
 * matching specific provider shapes rather than a generic high-entropy sweep.
 */

const QUERY_PARAM_RE = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"'<>]+/gi;
const BASIC_AUTH_RE = /(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi;
// Alchemy / Infura / Pimlico style — /v2/<key>, /v3/<key>, /rpc/<key>.
// Require ≥16 chars to avoid eating legitimate path segments like /v2/health.
const PATH_KEY_RE = /(\/(?:v[1-9]|rpc)\/)[A-Za-z0-9_-]{16,}(?=\/|$|\?|\s|"|'|<|>)/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const HEADER_KEY_RE = /((?:x-api-key|x-auth-token|authorization)\s*[:=]\s*)\S{8,}/gi;

export function sanitizeMessage(input: string): string {
  return input
    .replace(QUERY_PARAM_RE, '$1<redacted>')
    .replace(BASIC_AUTH_RE, '$1<redacted>@')
    .replace(PATH_KEY_RE, '$1<redacted>')
    .replace(BEARER_RE, '$1<redacted>')
    .replace(HEADER_KEY_RE, '$1<redacted>');
}

/**
 * Wraps an unknown thrown value in a new Error whose `.message` is sanitized
 * but whose `.cause` chain preserves the original (typed) error so downstream
 * retry/alerting logic that pattern-matches on viem error classes still works.
 *
 * `name` is propagated so `err.name === 'TransactionRejectedRpcError'`-style
 * checks continue to function.
 */
export function sanitizeError(err: unknown): Error {
  if (err instanceof Error) {
    const out = new Error(sanitizeMessage(err.message), { cause: err });
    out.name = err.name;
    return out;
  }
  return new Error(sanitizeMessage(String(err)), { cause: err });
}
