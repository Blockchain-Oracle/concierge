import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PIMLICO_KEY = 'test-pimlico-api-key';

function mockFetchOk(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

import { getUserOpGasPrice } from '../gasPrice.ts';

describe('getUserOpGasPrice — envelope guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError when body is valid JSON but a bare number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('42') }),
    );
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('not a JSON-RPC envelope'),
    );
  });

  it('throws RpcError when body is valid JSON null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('null') }),
    );
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('not a JSON-RPC envelope'),
    );
  });

  it('throws RpcError when body is a JSON object missing result and error keys', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ foo: 1 })),
      }),
    );
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('not a JSON-RPC envelope'),
    );
  });
});

describe('getUserOpGasPrice — value constraints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError when BigInt conversion fails on unparseable hex string', async () => {
    mockFetchOk({
      jsonrpc: '2.0',
      id: 1,
      result: {
        standard: { maxFeePerGas: '0xGGGGGG', maxPriorityFeePerGas: '0x3B9ACA00' },
        slow: {},
        fast: {},
      },
    });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('BigInt conversion failed'),
    );
  });

  it('throws RpcError when maxPriorityFeePerGas > maxFeePerGas (EIP-1559 invariant)', async () => {
    mockFetchOk({
      jsonrpc: '2.0',
      id: 1,
      result: {
        standard: { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x2' },
        slow: {},
        fast: {},
      },
    });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('EIP-1559 invariant violated'),
    );
  });

  it('network error message does not expose the API key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        !String(e.message).includes(TEST_PIMLICO_KEY),
    );
  });
});

describe('getUserOpGasPrice — gas price guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError when maxFeePerGas is zero (0x0)', async () => {
    mockFetchOk({
      jsonrpc: '2.0',
      id: 1,
      result: {
        standard: { maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' },
        slow: {},
        fast: {},
      },
    });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('zero or negative gas price'),
    );
  });

  it('throws RpcError when only maxPriorityFeePerGas is zero', async () => {
    mockFetchOk({
      jsonrpc: '2.0',
      id: 1,
      result: {
        standard: { maxFeePerGas: '0x5F5E100', maxPriorityFeePerGas: '0x0' },
        slow: {},
        fast: {},
      },
    });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('zero or negative gas price'),
    );
  });
});

describe('getUserOpGasPrice — hex format guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError when gas prices are decimal strings instead of 0x-prefixed hex', async () => {
    mockFetchOk({
      jsonrpc: '2.0',
      id: 1,
      result: {
        standard: { maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000000' },
        slow: {},
        fast: {},
      },
    });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('0x-prefixed hex strings'),
    );
  });

  it('throws RpcError when only maxPriorityFeePerGas is missing the 0x prefix', async () => {
    mockFetchOk({
      jsonrpc: '2.0',
      id: 1,
      result: {
        standard: { maxFeePerGas: '0x5F5E100', maxPriorityFeePerGas: '1000000000' },
        slow: {},
        fast: {},
      },
    });
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('0x-prefixed hex strings'),
    );
  });
});

describe('getUserOpGasPrice — ok-200 body read failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError with cause when res.text() rejects on a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.reject(new Error('stream aborted')),
      }),
    );
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('failed to read response body') &&
        e.cause instanceof Error,
    );
  });
});

describe('getUserOpGasPrice — body read failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws RpcError with body error in message and cause when res.text() throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.reject(new Error('connection reset')),
      }),
    );
    await expect(getUserOpGasPrice({ chain: 'mantle-sepolia' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        String(e.message).includes('body unreadable') &&
        String(e.message).includes('connection reset') &&
        e.cause instanceof Error,
    );
  });
});
