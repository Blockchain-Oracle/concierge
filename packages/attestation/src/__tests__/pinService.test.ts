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

describe('isValidCid — round-1 stricter regex', () => {
  it('accepts CIDv1 base32 lowercase', () => {
    expect(isValidCid(VALID_CIDV1)).toBe(true);
  });
  it('accepts CIDv0 base58btc', () => {
    expect(isValidCid(VALID_CIDV0)).toBe(true);
  });
  it('REJECTS uppercase CIDv1 (round-0 regex would pass; round-1 must not)', () => {
    expect(isValidCid('bafyBEIBQ2J5P4D3XRR5N6JXHQXHQXHQXHQXHQXHQXHQXHQXHQXHQXHQXHQ')).toBe(false);
  });
  it('REJECTS bafy with arbitrary suffix shorter than 52 chars', () => {
    expect(isValidCid('bafyabc')).toBe(false);
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
