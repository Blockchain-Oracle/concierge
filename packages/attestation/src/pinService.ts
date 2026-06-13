/**
 * DI'd pin-service interface. Production wires Pinata via createPinata
 * PinService; tests stub the interface with in-memory fakes. Per CLAUDE.md
 * non-negotiable #1 (no hot-path mocks) the seam is the interface, not the
 * network mock.
 *
 * **Round-1 (post-CRITICAL):** the web3.storage adapter was DROPPED in this
 * round — Storacha's current upload path requires a UCAN delegation client
 * + signing, NOT a simple Bearer-token HTTP shape. Shipping the broken
 * `/upload` adapter would be a "half-built feature in hot path." The
 * interface stays so a second provider (Pinata backup account, Lighthouse,
 * a real Storacha client, etc.) can be wired in a follow-up.
 */
/** Production wires 'pinata' here; second adapter (future) can use any string. */
export type PinServiceName = string;

export interface PinService {
  readonly name: PinServiceName;
  /** Returns CID + service-specific pin id. Throws on failure. */
  pin(args: {
    readonly canonical: string;
    readonly displayName: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly cid: string; readonly pinId: string }>;
}

/** Sentinel for the "not configured" branch — distinguished from adapter throws. */
export class PinServiceNotConfigured extends Error {
  constructor(name: string) {
    super(`pin service '${name}' not configured`);
    this.name = 'PinServiceNotConfigured';
  }
}

const PINATA_V3_HOST = 'https://uploads.pinata.cloud';

/**
 * CIDv1 base32 lowercase (any codec) + CIDv0 base58btc regex.
 *
 * Round-2 CRITICAL fix: round-1's `^bafy[a-z2-7]{52,}$` only accepted
 * dag-pb codec. Pinata V3 returns `bafk` for the `raw` codec, which is
 * what we ACTUALLY get when uploading JSON via multipart. The round-1
 * regex would silently reject every legitimate Pinata V3 response with
 * "malformed CID." Broadened to `ba[a-z2-7]{56,256}$` accepting all
 * base32-encoded CIDv1 codecs (bafy/bafk/bafr/etc) with a 256-char
 * upper bound (CWE-1284 DoS guard; real CIDv1 sha2-256 is ~59 chars).
 */
const CID_V1_RE = /^ba[a-z2-7]{56,256}$/;
const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
function isValidCid(s: string): boolean {
  return CID_V1_RE.test(s) || CID_V0_RE.test(s);
}

/**
 * Pinata V3 multipart-file upload. CRITICAL round-1 fix: the round-0
 * adapter used `pinJSONToIPFS` which JSON.parse → JSON.stringify the body,
 * SILENTLY breaking the canonicalize → keccak → on-chain dataHash chain.
 * V3 multipart sends the raw canonical bytes verbatim so the IPFS-pinned
 * content is byte-identical to what we hashed locally. Verified at
 * https://docs.pinata.cloud/api-reference/endpoint/upload-a-file 2026-06-13.
 */
export function createPinataPinService(config: {
  readonly jwt: string;
  readonly host?: string;
  readonly fetch?: typeof fetch;
  /** 'public' (free tier default) or 'private'. */
  readonly network?: 'public' | 'private';
}): PinService {
  const host = config.host ?? PINATA_V3_HOST;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const network = config.network ?? 'public';
  return {
    name: 'pinata',
    async pin({ canonical, displayName, signal }) {
      // Round-2 CWE-93: sanitize before multipart embedding. Control chars
      // and quotes could escape the Content-Disposition `filename="…"` line
      // in legacy multipart encoders. WHATWG FormData URL-encodes today,
      // but defense-in-depth keeps the data Pinata-dashboard-friendly too.
      const safeName = sanitizeDisplayName(displayName);
      const form = new FormData();
      // Blob with explicit JSON content-type preserves raw bytes; multipart
      // encoder does NOT re-serialize. THIS is the round-1 CRITICAL fix.
      form.set('file', new Blob([canonical], { type: 'application/json' }), `${safeName}.json`);
      form.set('network', network);
      form.set('name', safeName);
      const res = await fetchImpl(`${host}/v3/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.jwt}` },
        body: form,
        signal,
      });
      if (!res.ok) {
        // Round-2 CWE-117: strip control chars from server-supplied statusText
        // to prevent log-line forgery.
        const safeStatus = stripCtrl(res.statusText).slice(0, 128);
        throw new Error(`pinata: ${res.status} ${safeStatus}`);
      }
      const body = (await res.json()) as { data?: { cid?: unknown }; error?: unknown };
      // Round-2: handle the 200-with-error-envelope case. Pinata can return
      // 200 + `{ error: 'quota exceeded' }` for soft failures. Without this
      // check, body.data?.cid is undefined and the malformed-CID error path
      // catches it — but with a cryptic "''" message instead of the real cause.
      if (body.error !== undefined) {
        const safeErr = stripCtrl(String(body.error)).slice(0, 512);
        throw new Error(`pinata: 200 with error envelope: ${safeErr}`);
      }
      const cid = typeof body.data?.cid === 'string' ? body.data.cid : '';
      if (!isValidCid(cid)) {
        throw new Error(`pinata: returned malformed CID '${cid.slice(0, 64)}'`);
      }
      return { cid, pinId: `pinata:${cid}` };
    },
  };
}

/** Allow `[A-Za-z0-9_.-]` only; cap 128. Prevents CR/LF/quote injection (CWE-93). */
function sanitizeDisplayName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

function stripCtrl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control strip (CWE-117 mitigation)
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

export { isValidCid };
