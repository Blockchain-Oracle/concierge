import { ConciergeError } from '@concierge/sdk';
import { isValidCid } from './pinService.ts';
import { type FeedbackEnvelope, parseFeedbackEnvelope } from './schema.ts';

/** Typed reasons a payload couldn't be returned — surfaces structured in the dashboard. */
export type PayloadError = 'NOT_FOUND' | 'SCHEMA_VIOLATION' | 'TIMEOUT' | 'INVALID_HASH';

const MAX_CONTENT_BYTES = 1_048_576; // 1MB — matches DB CHECK constraint
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;

/**
 * Persisted cache backing — DI'd so production uses Postgres (story-84 Drizzle
 * table) and tests use an in-memory Map. Returning `null` for a miss lets the
 * caller decide between local-fallback vs gateway-fetch without throwing.
 */
export interface IpfsCacheRepo {
  get(cid: string): Promise<{ readonly content: string } | null>;
  put(row: { readonly cid: string; readonly content: string }): Promise<void>;
  touch(cid: string): Promise<void>;
}

/**
 * Fetches raw bytes for a CID from an IPFS gateway. Throws `PayloadError`-shaped
 * `ConciergeError('RpcError')` on transport failure so the orchestrator can
 * downgrade per-entry rather than failing the whole batch.
 */
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
  readonly signal?: AbortSignal;
}

function stripCtrl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CWE-117 mitigation
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

function parseOrSchemaViolation(content: string): GetOrFetchResult {
  let envelope: FeedbackEnvelope;
  try {
    envelope = parseFeedbackEnvelope(JSON.parse(content));
  } catch (err) {
    const msg = err instanceof Error ? stripCtrl(err.message).slice(0, 256) : 'parse failed';
    return { ok: false, error: 'SCHEMA_VIOLATION', cause: msg };
  }
  return { ok: true, content, envelope, source: 'cache' };
}

/**
 * Cache-first lookup: returns cached envelope if present (and bumps
 * `lastAccessedAt` for LRU), otherwise fetches via gateway, validates, caches,
 * returns. Errors are returned as `{ ok: false }` — never thrown — so a single
 * bad CID in a batch doesn't fail the whole `loadAgentHistory` call.
 */
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
    const result = parseOrSchemaViolation(cached.content);
    // Cache content was validated on insert, so a SCHEMA_VIOLATION here means
    // the schema itself was tightened after caching — still surface, don't crash.
    return result;
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
    // Round-2 lesson applied: drop oversized payloads BEFORE parsing so a
    // hostile gateway can't OOM us. Cache CHECK constraint enforces same cap.
    return {
      ok: false,
      error: 'SCHEMA_VIOLATION',
      cause: `content exceeds ${MAX_CONTENT_BYTES} bytes`,
    };
  }

  const parsed = parseOrSchemaViolation(resp.text);
  if (!parsed.ok) return parsed;

  try {
    await deps.repo.put({ cid, content: resp.text });
  } catch (err) {
    // Cache write failure must not fail the read — surface as ok with
    // source='gateway' and let caller observe the cache-write log separately.
    if (err instanceof ConciergeError) throw err;
  }

  return { ok: true, content: resp.text, envelope: parsed.envelope, source: 'gateway' };
}

/**
 * Default gateway fetcher: tries primary, falls back to secondary on transport
 * error or non-2xx (per story-84 spec — both are free public gateways).
 * Production: `ipfs.io` primary + `cloudflare-ipfs.com` fallback.
 */
export function createGatewayFetcher(opts: {
  readonly primary: string;
  readonly fallback?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}): IpfsGatewayFetcher {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    async fetch(cid, signal) {
      const primaryUrl = `${opts.primary.replace(/\/$/, '')}/ipfs/${cid}`;
      try {
        const r = await fetchImpl(primaryUrl, { signal });
        if (r.ok) return { status: r.status, text: await r.text() };
        if (!opts.fallback) return { status: r.status, text: '' };
      } catch (err) {
        if (!opts.fallback) throw err;
      }
      const fallbackUrl = `${opts.fallback.replace(/\/$/, '')}/ipfs/${cid}`;
      const r = await fetchImpl(fallbackUrl, { signal });
      return { status: r.status, text: r.ok ? await r.text() : '' };
    },
  };
}
