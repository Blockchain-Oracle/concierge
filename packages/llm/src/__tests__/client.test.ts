import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient, mergeBetaHeader, PROMPT_CACHING_BETA } from '../client.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mergeBetaHeader (pure)', () => {
  it('returns just PROMPT_CACHING_BETA when caller has no beta header', () => {
    expect(mergeBetaHeader(undefined)).toBe(PROMPT_CACHING_BETA);
    expect(mergeBetaHeader('')).toBe(PROMPT_CACHING_BETA);
    expect(mergeBetaHeader('   ')).toBe(PROMPT_CACHING_BETA);
  });

  it('preserves caller order then appends PROMPT_CACHING_BETA', () => {
    expect(mergeBetaHeader('extended-thinking-2025')).toBe(
      `extended-thinking-2025,${PROMPT_CACHING_BETA}`,
    );
  });

  it('does not duplicate PROMPT_CACHING_BETA when already present (case-insensitive)', () => {
    expect(mergeBetaHeader(PROMPT_CACHING_BETA)).toBe(PROMPT_CACHING_BETA);
    // Round-2 fix: case-insensitive dedup.
    expect(mergeBetaHeader('Prompt-Caching-2024-07-31')).toBe('Prompt-Caching-2024-07-31');
    expect(mergeBetaHeader(`extended-thinking-2025,${PROMPT_CACHING_BETA}`)).toBe(
      `extended-thinking-2025,${PROMPT_CACHING_BETA}`,
    );
  });

  it('trims whitespace and drops empty parts', () => {
    expect(mergeBetaHeader('extended-thinking-2025 , , ,')).toBe(
      `extended-thinking-2025,${PROMPT_CACHING_BETA}`,
    );
  });

  it('SECURITY: rejects CRLF-injection attempts (CWE-93)', () => {
    expect(() => mergeBetaHeader('foo\r\nX-Api-Key: attacker')).toThrow(/forbidden chars/);
    expect(() => mergeBetaHeader('foo\nbar')).toThrow(/forbidden chars/);
  });

  it('SECURITY: rejects NUL / control chars', () => {
    expect(() => mergeBetaHeader('foo\x00bar')).toThrow(/forbidden chars/);
    expect(() => mergeBetaHeader('foo\x7fbar')).toThrow(/forbidden chars/);
  });

  it('SECURITY: rejects non-ASCII (incl. Cyrillic confusable)', () => {
    // Cyrillic 'х' (U+0445) — visually identical to ASCII 'x'.
    expect(() => mergeBetaHeader('х-api-key=evil')).toThrow(/forbidden chars/);
  });

  it('SECURITY: caps input length (CWE-770 DoS)', () => {
    expect(() => mergeBetaHeader('a,'.repeat(3000))).toThrow(/exceeds/);
  });

  it('SECURITY: caps token count', () => {
    expect(() => mergeBetaHeader('a,'.repeat(50))).toThrow(/too many beta tokens/);
  });
});

describe('createLlmClient — apiKey + header validation', () => {
  it('throws ConfigError on empty apiKey', () => {
    try {
      createLlmClient({ apiKey: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
    }
  });

  it('throws ConfigError on whitespace-only apiKey', () => {
    expect(() => createLlmClient({ apiKey: '   ' })).toThrow(/apiKey is required/);
  });

  it('throws ConfigError on non-string apiKey', () => {
    expect(() => createLlmClient({ apiKey: undefined as unknown as string })).toThrow(
      /apiKey is required/,
    );
  });

  it('returns an Anthropic client instance', () => {
    const client = createLlmClient({ apiKey: 'sk-ant-fixture-not-real' });
    expect(client).toBeDefined();
  });

  it('SECURITY: rejects reserved x-api-key', () => {
    expect(() =>
      createLlmClient({
        apiKey: 'sk-ant-fixture-not-real',
        defaultHeaders: { 'x-api-key': 'attacker-key' },
      }),
    ).toThrow(/reserved key 'x-api-key'/);
  });

  it('SECURITY: rejects Authorization header (any case)', () => {
    expect(() =>
      createLlmClient({
        apiKey: 'sk-ant-fixture-not-real',
        defaultHeaders: { Authorization: 'Bearer x' },
      }),
    ).toThrow(/reserved key/);
  });

  it('SECURITY: rejects anthropic-version override', () => {
    expect(() =>
      createLlmClient({
        apiKey: 'sk-ant-fixture-not-real',
        defaultHeaders: { 'anthropic-version': '1900-01-01' },
      }),
    ).toThrow(/reserved key/);
  });

  it('SECURITY: rejects header value with CRLF', () => {
    expect(() =>
      createLlmClient({
        apiKey: 'sk-ant-fixture-not-real',
        defaultHeaders: { 'x-tag': 'tick\r\nX-Api-Key: stolen' },
      }),
    ).toThrow(/forbidden chars/);
  });

  it('SECURITY: rejects header key with non-token chars', () => {
    expect(() =>
      createLlmClient({
        apiKey: 'sk-ant-fixture-not-real',
        defaultHeaders: { 'x tag': 'val' }, // space in key
      }),
    ).toThrow(/forbidden chars/);
  });

  it('accepts non-reserved custom headers (allowlist passthrough)', () => {
    const client = createLlmClient({
      apiKey: 'sk-ant-fixture-not-real',
      defaultHeaders: { 'x-telemetry-tag': 'concierge-tick-loop' },
    });
    expect(client).toBeDefined();
  });
});

describe('createLlmClient — baseURL CWE-918 defense', () => {
  it('rejects non-https baseURL', () => {
    expect(() =>
      createLlmClient({ apiKey: 'sk-ant-fixture-not-real', baseURL: 'http://evil.example/v1' }),
    ).toThrow(/must use https:/);
  });

  it('rejects malformed baseURL', () => {
    expect(() =>
      createLlmClient({ apiKey: 'sk-ant-fixture-not-real', baseURL: 'not a url' }),
    ).toThrow(/not a valid URL/);
  });

  it.each([
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.5/v1',
    'https://192.168.1.1/v1',
    'https://172.20.0.5/v1',
    'https://169.254.169.254/v1', // AWS IMDS
    'https://[::1]/v1',
    'https://[fe80::1]/v1',
    'https://[fd00::1]/v1',
  ])('SECURITY: rejects loopback/RFC1918/link-local: %s', (url) => {
    expect(() => createLlmClient({ apiKey: 'sk-ant-fixture-not-real', baseURL: url })).toThrow(
      /loopback\/private\/link-local/,
    );
  });

  it('SECURITY: rejects non-443 ports without opt-out', () => {
    expect(() =>
      createLlmClient({
        apiKey: 'sk-ant-fixture-not-real',
        baseURL: 'https://api.anthropic.com:25/v1',
      }),
    ).toThrow(/port '25' is not 443/);
  });

  it('accepts public https proxy on 443', () => {
    const client = createLlmClient({
      apiKey: 'sk-ant-fixture-not-real',
      baseURL: 'https://proxy.example.com/v1',
    });
    expect(client).toBeDefined();
  });

  it('allowPrivateBaseURL: true unlocks loopback + custom port (trusted-config opt-out)', () => {
    const client = createLlmClient({
      apiKey: 'sk-ant-fixture-not-real',
      baseURL: 'https://127.0.0.1:8443/v1',
      allowPrivateBaseURL: true,
    });
    expect(client).toBeDefined();
  });
});
