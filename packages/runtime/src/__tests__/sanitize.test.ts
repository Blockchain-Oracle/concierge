import { describe, expect, it } from 'vitest';
import { sanitizeError, sanitizeMessage } from '../sanitize.ts';

describe('sanitizeMessage — comprehensive leak surface (round-2)', () => {
  it('redacts query-string apikey/key/token/secret', () => {
    const out = sanitizeMessage('https://api.x/v2/rpc?apikey=FAKE_KEY&foo=ok');
    expect(out).not.toContain('FAKE_KEY');
    expect(out).toContain('<redacted>');
    expect(out).toContain('foo=ok');
  });

  it('redacts basic-auth user:pass@host URLs', () => {
    const out = sanitizeMessage('https://admin:FAKE_PASS@redis.internal/5');
    expect(out).not.toContain('FAKE_PASS');
    expect(out).toContain('<redacted>@');
  });

  it('redacts path-segment keys (Alchemy /v2/<key>, Infura /v3/<key>, Pimlico /rpc/<key>)', () => {
    for (const url of [
      'https://eth-mainnet.g.alchemy.com/v2/FAKE_ALCHEMY_KEY_LONGENOUGH/blocknumber',
      'https://mainnet.infura.io/v3/FAKE_INFURA_PROJECTID_LONGENOUGH',
      'https://api.pimlico.io/rpc/FAKE_PIMLICO_KEY_LONGENOUGH',
    ]) {
      const out = sanitizeMessage(url);
      expect(out).not.toMatch(/FAKE_(ALCHEMY|INFURA|PIMLICO)/);
    }
  });

  it('redacts Authorization Bearer + x-api-key header echoes', () => {
    const out = sanitizeMessage(
      '401: Authorization: Bearer FAKE_BEARER_TOKEN echoed; x-api-key: FAKE_HEADER_KEY',
    );
    expect(out).not.toContain('FAKE_BEARER_TOKEN');
    expect(out).not.toContain('FAKE_HEADER_KEY');
  });

  it('redacts JSON body apiKey/token/secret fields', () => {
    const out = sanitizeMessage('{"apiKey":"FAKE_JSON_KEY","other":"ok"}');
    expect(out).not.toContain('FAKE_JSON_KEY');
    expect(out).toContain('"other":"ok"');
  });

  it('does not eat tx hashes or addresses', () => {
    const input =
      '0x4444444444444444444444444444444444444444444444444444444444444444 at 0x1234567890123456789012345678901234567890';
    expect(sanitizeMessage(input)).toBe(input);
  });
});

describe('sanitizeError — cause chain + stack + cycle safety (CRITICAL round-2)', () => {
  it('preserves name + creates fresh Error reference (NOT the original)', () => {
    class CustomViemError extends Error {
      override name = 'CustomViemError';
    }
    const inner = new CustomViemError('rpc 401 at https://x.io/rpc?apikey=FAKE_INNER');
    const wrapped = sanitizeError(inner);
    expect(wrapped).not.toBe(inner);
    expect(wrapped.name).toBe('CustomViemError');
    expect(wrapped.message).toContain('<redacted>');
    expect(wrapped.message).not.toContain('FAKE_INNER');
  });

  it('recursively sanitizes cause chain — the round-1 leak surface', () => {
    const inner = new Error('Pimlico 401 at https://api.pimlico.io/v2/mantle?apikey=FAKE_DEEP');
    const middle = new Error('failed at https://x.io/rpc?apikey=FAKE_MID', { cause: inner });
    const outer = new Error('orchestrator', { cause: middle });
    const wrapped = sanitizeError(outer);
    // Walk the entire cause chain — NONE may contain raw keys.
    let cur: unknown = wrapped;
    while (cur instanceof Error) {
      expect(cur.message).not.toContain('FAKE_DEEP');
      expect(cur.message).not.toContain('FAKE_MID');
      cur = cur.cause;
    }
  });

  it('sanitizes the stack trace (URLs appear in stack frames)', () => {
    const e = new Error('rpc');
    e.stack = `Error: rpc\n    at fetch (https://api.pimlico.io/rpc?apikey=FAKE_STACK_KEY:5)`;
    const wrapped = sanitizeError(e);
    expect(wrapped.stack).not.toContain('FAKE_STACK_KEY');
    expect(wrapped.stack).toContain('<redacted>');
  });

  it('cycle-safe: bounded depth on circular cause chain', () => {
    const a: Error & { cause?: Error } = new Error('a');
    const b: Error & { cause?: Error } = new Error('b');
    a.cause = b;
    b.cause = a;
    const wrapped = sanitizeError(a);
    // Must not infinite-loop; must produce a finite-depth wrapper.
    let depth = 0;
    let cur: unknown = wrapped;
    while (cur instanceof Error && depth < 20) {
      depth++;
      cur = cur.cause;
    }
    expect(depth).toBeLessThanOrEqual(10);
  });

  it('fail-safe: throwing getter on .message returns generic error (does NOT throw)', () => {
    const evil = new Error('placeholder');
    Object.defineProperty(evil, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => sanitizeError(evil)).not.toThrow();
  });
});
