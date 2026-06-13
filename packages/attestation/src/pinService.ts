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
export type PinServiceName = 'pinata' | (string & { readonly __pinServiceName?: never });

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
 * Lightweight CIDv1 (base32 lowercase) + CIDv0 (base58btc) regex.
 *   - CIDv1 base32: `bafy[a-z2-7]{52,}` (multibase 'b' prefix → base32 lowercase no-padding)
 *   - CIDv0 base58btc: `Qm[1-9A-HJ-NP-Za-km-z]{44}` (excludes 0/O/I/l)
 * Avoids the multiformats runtime dep; tightens vs the round-0 startsWith.
 */
const CID_V1_RE = /^bafy[a-z2-7]{52,}$/;
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
      const form = new FormData();
      // Blob with explicit JSON content-type preserves the raw bytes; the
      // multipart encoder does not re-serialize.
      form.set(
        'file',
        new Blob([canonical], { type: 'application/json' }),
        `${displayName.slice(0, 128)}.json`,
      );
      form.set('network', network);
      form.set('name', displayName.slice(0, 128));
      const res = await fetchImpl(`${host}/v3/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.jwt}` },
        body: form,
        signal,
      });
      if (!res.ok) {
        throw new Error(`pinata: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { data?: { cid?: unknown } };
      const cid = typeof body.data?.cid === 'string' ? body.data.cid : '';
      if (!isValidCid(cid)) {
        throw new Error(`pinata: returned malformed CID '${cid.slice(0, 64)}'`);
      }
      return { cid, pinId: `pinata:${cid}` };
    },
  };
}

export { isValidCid };
