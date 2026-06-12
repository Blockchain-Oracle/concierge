import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PIMLICO_KEY = 'test-pimlico-api-key';

const MOCK_GAS_PRICE_RESPONSE = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    slow: { maxFeePerGas: '0x5F5E100', maxPriorityFeePerGas: '0x3B9ACA00' },
    standard: { maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3B9ACA00' },
    fast: { maxFeePerGas: '0x9502F900', maxPriorityFeePerGas: '0x3B9ACA00' },
  },
};

function mockFetchOk(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }),
  );
}

function mockFetchStatus(status: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    }),
  );
}

import { getUserOpGasPrice } from '../gasPrice.ts';

describe('getUserOpGasPrice — return shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
    mockFetchOk(MOCK_GAS_PRICE_RESPONSE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns maxFeePerGas and maxPriorityFeePerGas as bigints', async () => {
    const result = await getUserOpGasPrice({ chain: 'mantle-sepolia' });
    expect(typeof result.maxFeePerGas).toBe('bigint');
    expect(typeof result.maxPriorityFeePerGas).toBe('bigint');
  });

  it('returns fetchedAt as a numeric Unix ms timestamp', async () => {
    const before = Date.now();
    const result = await getUserOpGasPrice({ chain: 'mantle-sepolia' });
    const after = Date.now();
    expect(typeof result.fetchedAt).toBe('number');
    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAt).toBeLessThanOrEqual(after);
  });

  it('returns positive gas prices', async () => {
    const result = await getUserOpGasPrice({ chain: 'mantle-sepolia' });
    expect(result.maxFeePerGas).toBeGreaterThan(0n);
    expect(result.maxPriorityFeePerGas).toBeGreaterThan(0n);
  });

  it('uses standard gas price tier', async () => {
    const result = await getUserOpGasPrice({ chain: 'mantle-mainnet' });
    expect(result.maxFeePerGas).toBe(BigInt('0x77359400'));
    expect(result.maxPriorityFeePerGas).toBe(BigInt('0x3B9ACA00'));
  });
});

describe('getUserOpGasPrice — RPC call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
    mockFetchOk(MOCK_GAS_PRICE_RESPONSE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('calls pimlico_getUserOperationGasPrice method', async () => {
    await getUserOpGasPrice({ chain: 'mantle-sepolia' });
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string);
    expect(body.method).toBe('pimlico_getUserOperationGasPrice');
    expect(body.jsonrpc).toBe('2.0');
    expect(body.params).toEqual([]);
  });

  it('calls Pimlico sepolia endpoint', async () => {
    await getUserOpGasPrice({ chain: 'mantle-sepolia' });
    const [url] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toContain('pimlico.io/v2/mantle-sepolia/rpc');
    expect(url).toContain(`apikey=${TEST_PIMLICO_KEY}`);
  });

  it('calls Pimlico mainnet endpoint', async () => {
    await getUserOpGasPrice({ chain: 'mantle-mainnet' });
    const [url] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toContain('pimlico.io/v2/mantle/rpc');
  });

  it('accepts apiKey override', async () => {
    vi.unstubAllEnvs();
    await getUserOpGasPrice({ chain: 'mantle-sepolia', apiKey: 'override-key' });
    const [url] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toContain('apikey=override-key');
  });
});

describe('getUserOpGasPrice — config errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws ConfigError when PIMLICO_API_KEY is missing', async () => {
    vi.unstubAllEnvs();
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes("MissingEnvVar('PIMLICO_API_KEY')"),
    );
  });

  it('throws ConfigError for unsupported chain', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
      getUserOpGasPrice({ chain: 'ethereum-mainnet' as any }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('wraps fetch network error as RpcError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('getUserOpGasPrice — response errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError on HTTP 5xx from bundler', async () => {
    mockFetchStatus(503);
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes("BundlerError({ status: 503, chain: 'mantle-sepolia' })"),
    );
  });

  it('throws RpcError on HTTP 401 from bundler', async () => {
    mockFetchStatus(401);
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('status: 401'),
    );
  });

  it('throws RpcError when JSON-RPC returns error object', async () => {
    mockFetchOk({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'AA23 reverted' } });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when result is null', async () => {
    mockFetchOk({ jsonrpc: '2.0', id: 1, result: null });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when result.standard is missing', async () => {
    mockFetchOk({ jsonrpc: '2.0', id: 1, result: {} });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});
