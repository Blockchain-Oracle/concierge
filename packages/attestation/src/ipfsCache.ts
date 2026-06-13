import { ConciergeError } from '@concierge/sdk';
import { isValidCid } from './pinService.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope } from './schema.ts';

/** Typed reasons a payload couldn't be returned — surfaces structured in the dashboard. */
export type PayloadError = 'NOT_FOUND' | 'SCHEMA_VIOLATION' | 'TIMEOUT' | 'INVALID_HASH';

export const MAX_CONTENT_BYTES = 1_048_576; // 1MB — matches DB CHECK constraint
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
}

export interface IpfsGatewayFetcher {
  fetch(
    cid: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: number; readonly text: string }>;
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

/** Parses + schema-validates content; returns ONLY the envelope so callers
 *  attach their own `source` discriminator (no misleading literal default). */
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

export async function getOrFetchPayload(
  cid: string,
  deps: GetOrFetchDeps,
): Promise<GetOrFetchResult> {
  if (!isValidCid(cid)) {
    return { ok: false, error: 'NOT_FOUND', cause: 'invalid CID shape' };
  }

  const cached = await deps.repo.get(cid);
  if (cached !== null) {
    await deps.repo.touch(cid);
    const parsed = parseEnvelope(cached.content);
    if (!parsed.ok) return { ok: false, error: 'SCHEMA_VIOLATION', cause: parsed.cause };
    return { ok: true, content: cached.content, envelope: parsed.envelope, source: 'cache' };
  }

  const signal = deps.signal ?? AbortSignal.timeout(DEFAULT_GATEWAY_TIMEOUT_MS);
  let resp: { readonly status: number; readonly text: string };
  try {
    resp = await deps.gateway.fetch(cid, signal);
  } catch (err) {
    const isAbort =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const msg =
      err instanceof Error ? stripCtrl(err.message).slice(0, 256) : 'gateway fetch failed';
    return { ok: false, error: isAbort ? 'TIMEOUT' : 'NOT_FOUND', cause: msg };
  }

  if (resp.status === 404) return { ok: false, error: 'NOT_FOUND', cause: 'gateway 404' };
  if (resp.status < 200 || resp.status >= 300) {
    return { ok: false, error: 'NOT_FOUND', cause: `gateway status ${resp.status}` };
  }
  if (resp.text.length > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error: 'SCHEMA_VIOLATION',
      cause: `content exceeds ${MAX_CONTENT_BYTES} bytes`,
    };
  }

  const parsed = parseEnvelope(resp.text);
  if (!parsed.ok) return { ok: false, error: 'SCHEMA_VIOLATION', cause: parsed.cause };

  try {
    await deps.repo.put({ cid, content: resp.text });
  } catch (err) {
    // Round-1 (silent-failure CRITICAL): emit observable log before swallowing.
    // Read MUST succeed even if cache write fails (content-addressed; re-fetch
    // is idempotent), but ops must see the cache degradation.
    deps.logger?.error(
      {
        cid,
        errName: err instanceof Error ? err.name : 'unknown',
        errMessage:
          err instanceof Error ? stripCtrl(err.message).slice(0, 512) : String(err).slice(0, 512),
      },
      'ipfsCache.put failed (read returned ok; subsequent reads will re-fetch)',
    );
    if (err instanceof ConciergeError) throw err;
  }

  return { ok: true, content: resp.text, envelope: parsed.envelope, source: 'gateway' };
}

/** Round-1 CWE-918: validate gateway base URL config. Origin-only, http(s). */
function validateGatewayBase(label: string, base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/attestation] ${label} URL must be a valid absolute URL (got '${stripCtrl(base).slice(0, 128)}').`,
    );
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/attestation] ${label} URL must use http(s) scheme (got '${stripCtrl(url.protocol)}').`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/attestation] ${label} URL must be origin-only (no path/query/fragment): '${stripCtrl(base).slice(0, 128)}'.`,
    );
  }
  return url;
}

/**
 * Default gateway fetcher with streaming size cap (CWE-770) + base URL
 * validation (CWE-918). Tries primary → fallback on transport error or non-2xx.
 */
export function createGatewayFetcher(opts: {
  readonly primary: string;
  readonly fallback?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}): IpfsGatewayFetcher {
  const primaryOrigin = validateGatewayBase('primary', opts.primary).origin;
  const fallbackOrigin =
    opts.fallback !== undefined ? validateGatewayBase('fallback', opts.fallback).origin : null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  // Round-1 CWE-770: stream the body with a running counter so a hostile
  // gateway streaming GBs can't OOM before the size guard fires.
  const fetchCapped = async (
    url: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: number; readonly text: string }> => {
    const r = await fetchImpl(url, { signal });
    if (!r.ok) return { status: r.status, text: '' };
    const lenHeader = r.headers.get('content-length');
    if (lenHeader !== null && Number.parseInt(lenHeader, 10) > MAX_CONTENT_BYTES) {
      // Surface oversized as SCHEMA_VIOLATION upstream via the post-fetch cap.
      return { status: r.status, text: 'x'.repeat(MAX_CONTENT_BYTES + 1) };
    }
    if (r.body === null) return { status: r.status, text: await r.text() };

    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CONTENT_BYTES) {
        await reader.cancel();
        return { status: r.status, text: 'x'.repeat(MAX_CONTENT_BYTES + 1) };
      }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
    );
    return { status: r.status, text };
  };

  return {
    async fetch(cid, signal) {
      const primaryUrl = `${primaryOrigin}/ipfs/${cid}`;
      try {
        const r = await fetchCapped(primaryUrl, signal);
        if (r.status >= 200 && r.status < 300) return r;
        if (fallbackOrigin === null) return r;
      } catch (err) {
        if (fallbackOrigin === null) throw err;
      }
      return fetchCapped(`${fallbackOrigin}/ipfs/${cid}`, signal);
    },
  };
}
