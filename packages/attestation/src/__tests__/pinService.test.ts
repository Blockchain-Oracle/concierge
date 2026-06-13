import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinataPinService, isValidCid } from '../pinService.ts';

afterEach(() => vi.restoreAllMocks());

const VALID_CIDV1 = 'bafybeibq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';
const VALID_CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CANONICAL = '{"v":1,"schema":"s","payload":{}}';

function ok(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => json,
    // biome-ignore lint/suspicious/noExplicitAny: minimal Response stub
  } as any;
}

function fail(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    // biome-ignore lint/suspicious/noExplicitAny: minimal Response stub
  } as any;
}

describe('isValidCid — round-2 broadened across CIDv1 codecs', () => {
  it('accepts CIDv1 dag-pb (bafy prefix)', () => {
    expect(isValidCid(VALID_CIDV1)).toBe(true);
  });
  it('round-2 CRITICAL: accepts CIDv1 raw codec (bafk prefix) — Pinata V3 returns this for JSON uploads', () => {
    const bafk = `bafk${'a'.repeat(56)}`;
    expect(isValidCid(bafk)).toBe(true);
  });
  it('accepts CIDv1 dag-cbor (bafyr prefix variant) + any base32 codec', () => {
    expect(isValidCid(`bafr${'2'.repeat(56)}`)).toBe(true);
  });
  it('accepts CIDv0 base58btc', () => {
    expect(isValidCid(VALID_CIDV0)).toBe(true);
  });
  it('REJECTS uppercase CIDv1', () => {
    expect(isValidCid('bafyBEIBQ2J5P4D3XRR5N6JXHQXHQXHQXHQXHQXHQXHQXHQXHQXHQXHQXHQ')).toBe(false);
  });
  it('REJECTS short suffix', () => {
    expect(isValidCid('bafyabc')).toBe(false);
  });
  it('round-2 CWE-1284: REJECTS suffix > 256 chars (DoS guard)', () => {
    expect(isValidCid(`bafy${'a'.repeat(300)}`)).toBe(false);
  });
  it('REJECTS Qm with wrong length', () => {
    expect(isValidCid('Qm12345')).toBe(false);
  });
  it('REJECTS empty string', () => {
    expect(isValidCid('')).toBe(false);
  });
});

describe('createPinataPinService — V3 multipart (round-1 CRITICAL fix: raw bytes, no JSON re-serialization)', () => {
  it('POSTs to /v3/files with multipart FormData; Bearer JWT', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: { cid: VALID_CIDV1 } }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    const out = await svc.pin({
      canonical: CANONICAL,
      displayName: 'x',
      signal: new AbortController().signal,
    });
    expect(out.cid).toBe(VALID_CIDV1);
    expect(out.pinId).toBe(`pinata:${VALID_CIDV1}`);
    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch invoked');
    expect(call[0]).toContain('/v3/files');
    expect((call[1].headers as Record<string, string>)['authorization']).toBe('Bearer jwt-1');
    expect(call[1].body).toBeInstanceOf(FormData);
    // CRITICAL: the body must contain a Blob (raw bytes), NOT a JSON-stringified
    // object that Pinata would re-serialize.
    const form = call[1].body as FormData;
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
  });

  it('non-2xx → throws with status + statusText', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fail(503, 'Service Unavailable'));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await expect(
      svc.pin({ canonical: CANONICAL, displayName: 'x', signal: new AbortController().signal }),
    ).rejects.toThrow(/503.*Service Unavailable/);
  });

  it('200 + malformed CID → throws (real CID parser, NOT just startsWith bafy)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: { cid: 'bafyMALICIOUS' } }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await expect(
      svc.pin({ canonical: CANONICAL, displayName: 'x', signal: new AbortController().signal }),
    ).rejects.toThrow(/malformed CID/);
  });

  it('truncates displayName to 128 chars (Pinata metadata cap)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: { cid: VALID_CIDV1 } }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await svc.pin({
      canonical: CANONICAL,
      displayName: 'x'.repeat(500),
      signal: new AbortController().signal,
    });
    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch invoked');
    const form = call[1].body as FormData;
    expect(String(form.get('name')).length).toBe(128);
  });

  it('passes the AbortSignal through to fetch (round-1 NEW)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: { cid: VALID_CIDV1 } }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    const ctl = new AbortController();
    await svc.pin({ canonical: CANONICAL, displayName: 'x', signal: ctl.signal });
    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch invoked');
    expect(call[1].signal).toBe(ctl.signal);
  });

  it('network error (fetch rejects) → propagates as adapter throw', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await expect(
      svc.pin({ canonical: CANONICAL, displayName: 'x', signal: new AbortController().signal }),
    ).rejects.toThrow(/ECONNRESET/);
  });
});

describe('createPinataPinService — round-2 hardening', () => {
  it('CRITICAL byte-identical round-trip: the Blob payload === CANONICAL (locks the V3 fix)', async () => {
    // Pre-round-2 test only checked `file instanceof Blob`; a regression
    // wrapping CANONICAL in JSON.stringify before `new Blob([...])` would
    // STILL produce a Blob and pass. This reads the actual bytes back.
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: { cid: VALID_CIDV1 } }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await svc.pin({
      canonical: CANONICAL,
      displayName: 'x',
      signal: new AbortController().signal,
    });
    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch invoked');
    const form = call[1].body as FormData;
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new Error('expected Blob file part');
    const text = await file.text();
    expect(text).toBe(CANONICAL);
  });

  it('200 with `{ error }` envelope → throws WITH the error message (no opaque malformed-CID)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ error: 'quota exceeded' }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await expect(
      svc.pin({ canonical: CANONICAL, displayName: 'x', signal: new AbortController().signal }),
    ).rejects.toThrow(/quota exceeded/);
  });

  it('200 with `{ data: {} }` (missing cid) → throws malformed-CID (NOT TypeError)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: {} }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await expect(
      svc.pin({ canonical: CANONICAL, displayName: 'x', signal: new AbortController().signal }),
    ).rejects.toThrow(/malformed CID/);
  });

  it('CWE-93: displayName with CR/LF/quote characters → sanitized in multipart fields', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(ok({ data: { cid: VALID_CIDV1 } }));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    await svc.pin({
      canonical: CANONICAL,
      displayName: 'bad\r\nname"with quote',
      signal: new AbortController().signal,
    });
    const call = fetchSpy.mock.calls[0];
    if (call === undefined) throw new Error('expected fetch invoked');
    const form = call[1].body as FormData;
    const nameField = String(form.get('name'));
    expect(nameField).not.toContain('\r');
    expect(nameField).not.toContain('\n');
    expect(nameField).not.toContain('"');
  });

  it('CWE-117: server statusText with control chars → stripped in error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fail(503, 'Service\nUnavailable\r\n[ADMIN]'));
    const svc = createPinataPinService({ jwt: 'jwt-1', fetch: fetchSpy });
    let caught: unknown = null;
    try {
      await svc.pin({
        canonical: CANONICAL,
        displayName: 'x',
        signal: new AbortController().signal,
      });
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof Error)) throw new Error('expected Error');
    expect(caught.message).not.toContain('\n');
    expect(caught.message).not.toContain('\r');
  });
});
