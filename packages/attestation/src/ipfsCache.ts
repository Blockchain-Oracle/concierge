import { ConciergeError } from '@concierge/sdk';
import { isValidCid } from './pinService.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope } from './schema.ts';

/** Typed reasons a payload couldn't be returned — surfaces structured in the dashboard. */
export type PayloadError = 'NOT_FOUND' | 'SCHEMA_VIOLATION' | 'TIMEOUT' | 'INVALID_HASH';

export const MAX_CONTENT_BYTES = 1_048_576; // 1MB — keep in sync with ipfs_cache CHECK
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;
const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

function stripCtrl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CWE-117 mitigation
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

export interface IpfsCacheRepo {
  get(cid: string): Promise<{ readonly content: string } | null>;
  put(row: { readonly cid: string; readonly content: string }): Promise<void>;
  touch(cid: string): Promise<void>;
  /** Round-2: eviction needed when cached content fails CURRENT schema (rotation). */
  delete(cid: string): Promise<void>;
}

/**
 * Round-2 typed gateway result — replaces the `'x'.repeat()` oversize sentinel
 * that ironically allocated the very memory the cap exists to prevent.
 */
export type GatewayFetchResult =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | { readonly ok: false; readonly reason: 'oversized' | 'http'; readonly status: number };

export interface IpfsGatewayFetcher {
  fetch(cid: string, signal: AbortSignal): Promise<GatewayFetchResult>;
}

export type GetOrFetchResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly envelope: FeedbackEnvelope;
      readonly source: 'cache' | 'gateway';
    }
  | { readonly ok: false; readonly error: PayloadError; readonly cause?: string };

export interface GetOrFetchDeps {
  readonly repo: IpfsCacheRepo;
  readonly gateway: IpfsGatewayFetcher;
  readonly logger?: { error(meta: Record<string, unknown>, msg: string): void };
  readonly signal?: AbortSignal;
}

function parseEnvelope(
  content: string,
): { ok: true; envelope: FeedbackEnvelope } | { ok: false; cause: string } {
  try {
    return { ok: true, envelope: parseFeedbackEnvelope(JSON.parse(content)) };
  } catch (err) {
    const msg = err instanceof Error ? stripCtrl(err.message).slice(0, 256) : 'parse failed';
    return { ok: false, cause: msg };
  }
}

async function tryGatewayFetch(
  cid: string,
  deps: GetOrFetchDeps,
  signal: AbortSignal,
): Promise<GetOrFetchResult> {
  let resp: GatewayFetchResult;
  try {
    resp = await deps.gateway.fetch(cid, signal);
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const msg =
      err instanceof Error ? stripCtrl(err.message).slice(0, 256) : 'gateway fetch failed';
    return { ok: false, error: isAbort ? 'TIMEOUT' : 'NOT_FOUND', cause: msg };
  }

  if (!resp.ok) {
    if (resp.reason === 'oversized') {
      return {
        ok: false,
        error: 'SCHEMA_VIOLATION',
        cause: `content exceeds ${MAX_CONTENT_BYTES} bytes`,
      };
    }
    if (resp.status === 404) return { ok: false, error: 'NOT_FOUND', cause: 'gateway 404' };
    return { ok: false, error: 'NOT_FOUND', cause: `gateway status ${resp.status}` };
  }

  const parsed = parseEnvelope(resp.text);
  if (!parsed.ok) return { ok: false, error: 'SCHEMA_VIOLATION', cause: parsed.cause };

  try {
    await deps.repo.put({ cid, content: resp.text });
  } catch (err) {
    // Round-2: drop the ConciergeError re-throw — contract is "read MUST
    // succeed even if cache write fails". Log every failure so ops sees
    // cache degradation; never propagate to caller.
    deps.logger?.error(
      {
        cid,
        errName: err instanceof Error ? err.name : 'unknown',
        errMessage:
          err instanceof Error ? stripCtrl(err.message).slice(0, 512) : String(err).slice(0, 512),
      },
      'ipfsCache.put failed (read returned ok; subsequent reads will re-fetch)',
    );
  }

  return { ok: true, content: resp.text, envelope: parsed.envelope, source: 'gateway' };
}

export async function getOrFetchPayload(
  cid: string,
  deps: GetOrFetchDeps,
): Promise<GetOrFetchResult> {
  if (!isValidCid(cid)) {
    return { ok: false, error: 'NOT_FOUND', cause: 'invalid CID shape' };
  }

  const cached = await deps.repo.get(cid);
  if (cached !== null) {
    const parsed = parseEnvelope(cached.content);
    if (parsed.ok) {
      await deps.repo.touch(cid);
      return { ok: true, content: cached.content, envelope: parsed.envelope, source: 'cache' };
    }
    // Round-2 silent-failure HIGH: cache-hit SCHEMA_VIOLATION means schema
    // rotated since write. Log, evict (don't touch LRU on poison), fall
    // through to gateway. Content-addressed → re-fetch yields identical
    // bytes; parse will fail again, but the cache stops poisoning silently.
    deps.logger?.error(
      { cid, cause: parsed.cause },
      'ipfsCache hit failed CURRENT schema — evicting stale row + re-fetching',
    );
    try {
      await deps.repo.delete(cid);
    } catch (err) {
      deps.logger?.error(
        {
          cid,
          errName: err instanceof Error ? err.name : 'unknown',
          errMessage:
            err instanceof Error ? stripCtrl(err.message).slice(0, 512) : String(err).slice(0, 512),
        },
        'ipfsCache.delete failed during stale-row eviction',
      );
    }
  }

  const signal = deps.signal ?? AbortSignal.timeout(DEFAULT_GATEWAY_TIMEOUT_MS);
  return tryGatewayFetch(cid, deps, signal);
}

/** Round-2 simplification: collapse 3 URL-validation throws into a code map. */
const URL_VALIDATION_MESSAGES: Record<string, string> = {
  parse: 'must be a valid absolute URL',
  scheme: 'must use http(s) scheme',
  origin: 'must be origin-only (no path/query/fragment)',
};

function validateGatewayUrl(
  base: string,
): { ok: true; origin: string } | { ok: false; code: keyof typeof URL_VALIDATION_MESSAGES } {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, code: 'parse' };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { ok: false, code: 'scheme' };
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, code: 'origin' };
  }
  return { ok: true, origin: url.origin };
}

function gatewayBaseOrigin(label: string, base: string): string {
  const v = validateGatewayUrl(base);
  if (v.ok) return v.origin;
  throw new ConciergeError(
    'ConfigError',
    `[@concierge/attestation] ${label} URL ${URL_VALIDATION_MESSAGES[v.code]} (got '${stripCtrl(base).slice(0, 128)}').`,
  );
}

/**
 * Default gateway fetcher with streaming size cap (CWE-770) + base URL
 * validation (CWE-918). Returns typed `GatewayFetchResult` — no sentinel strings.
 */
export function createGatewayFetcher(opts: {
  readonly primary: string;
  readonly fallback?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}): IpfsGatewayFetcher {
  const primaryOrigin = gatewayBaseOrigin('primary', opts.primary);
  const fallbackOrigin =
    opts.fallback !== undefined ? gatewayBaseOrigin('fallback', opts.fallback) : null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const fetchCapped = async (url: string, signal: AbortSignal): Promise<GatewayFetchResult> => {
    const r = await fetchImpl(url, { signal });
    if (!r.ok) return { ok: false, reason: 'http', status: r.status };

    const lenHeader = r.headers.get('content-length');
    if (lenHeader !== null) {
      const declared = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_CONTENT_BYTES) {
        return { ok: false, reason: 'oversized', status: r.status };
      }
    }

    // Round-2 silent-failure HIGH: when r.body is null, .text() is uncapped.
    // Defensively cap the resulting string so a hostile gateway hiding
    // content in a body-null response can't bypass the streaming counter.
    if (r.body === null) {
      const text = await r.text();
      if (text.length > MAX_CONTENT_BYTES) {
        return { ok: false, reason: 'oversized', status: r.status };
      }
      return { ok: true, status: r.status, text };
    }

    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONTENT_BYTES) {
        await reader.cancel();
        return { ok: false, reason: 'oversized', status: r.status };
      }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
    );
    return { ok: true, status: r.status, text };
  };

  return {
    async fetch(cid, signal) {
      const primaryUrl = `${primaryOrigin}/ipfs/${cid}`;
      try {
        const r = await fetchCapped(primaryUrl, signal);
        if (r.ok) return r;
        if (fallbackOrigin === null) return r;
      } catch (err) {
        if (fallbackOrigin === null) throw err;
      }
      return fetchCapped(`${fallbackOrigin}/ipfs/${cid}`, signal);
    },
  };
}
