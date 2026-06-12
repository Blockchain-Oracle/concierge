import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PIMLICO_KEY = 'test-pimlico-api-key';

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    http: vi.fn().mockImplementation((url: string) => ({ type: 'transport', url })),
  };
});

vi.mock('viem/account-abstraction', async () => {
  const actual = await vi.importActual<typeof import('viem/account-abstraction')>(
    'viem/account-abstraction',
  );
  return {
    ...actual,
    createBundlerClient: vi.fn().mockReturnValue({ type: 'bundlerClient' }),
    createPaymasterClient: vi.fn().mockReturnValue({ type: 'paymasterClient' }),
  };
});

import { createBundlerClient } from '../bundler.ts';

describe('createBundlerClient — return shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns bundlerClient and paymasterClient for mantle-sepolia', () => {
    const result = createBundlerClient({ chain: 'mantle-sepolia' });
    expect(result).toHaveProperty('bundlerClient');
    expect(result).toHaveProperty('paymasterClient');
    expect(result.paymasterClient).not.toBeNull();
  });

  it('returns bundlerClient with null paymasterClient for mantle-mainnet', () => {
    const result = createBundlerClient({ chain: 'mantle-mainnet' });
    expect(result.bundlerClient).toBeDefined();
    expect(result.paymasterClient).toBeNull();
  });
});

describe('createBundlerClient — bundler URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes Pimlico sepolia URL with API key', async () => {
    const { http } = await import('viem');
    createBundlerClient({ chain: 'mantle-sepolia' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(
      `https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=${TEST_PIMLICO_KEY}`,
    );
  });

  it('passes Pimlico mainnet URL with API key', async () => {
    const { http } = await import('viem');
    createBundlerClient({ chain: 'mantle-mainnet' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(`https://api.pimlico.io/v2/mantle/rpc?apikey=${TEST_PIMLICO_KEY}`);
  });

  it('accepts apiKey override instead of env', async () => {
    vi.unstubAllEnvs();
    const { http } = await import('viem');
    createBundlerClient({ chain: 'mantle-sepolia', apiKey: 'override-key' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain('https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=override-key');
  });
});

describe('createBundlerClient — input guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws ConfigError when PIMLICO_API_KEY is missing', () => {
    vi.unstubAllEnvs();
    expect(() => createBundlerClient({ chain: 'mantle-sepolia' })).toThrowError(
      expect.objectContaining({
        type: 'ConfigError',
        message: expect.stringContaining("MissingEnvVar('PIMLICO_API_KEY')"),
      }) as unknown as Error,
    );
  });

  it('throws ConfigError with ConciergeError instance for missing key', () => {
    vi.unstubAllEnvs();
    expect(() => createBundlerClient({ chain: 'mantle-sepolia' })).toSatisfy(() => {
      try {
        createBundlerClient({ chain: 'mantle-sepolia' });
        return false;
      } catch (e) {
        return e instanceof ConciergeError && e.type === 'ConfigError';
      }
    });
  });

  it('throws ConfigError for unsupported chain', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
      createBundlerClient({ chain: 'ethereum-mainnet' as any }),
    ).toThrowError(expect.objectContaining({ type: 'ConfigError' }) as unknown as Error);
  });
});
