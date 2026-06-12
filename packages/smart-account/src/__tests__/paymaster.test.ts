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
    createPaymasterClient: vi.fn().mockReturnValue({ type: 'paymasterClient' }),
  };
});

import { createPaymasterClient } from '../paymaster.ts';

describe('createPaymasterClient — sponsorshipPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null for sponsorshipPolicy 'never'", () => {
    const result = createPaymasterClient({
      chain: 'mantle-mainnet',
      sponsorshipPolicy: 'never',
    });
    expect(result).toBeNull();
  });

  it("returns non-null PaymasterClient for sponsorshipPolicy 'always'", () => {
    const result = createPaymasterClient({
      chain: 'mantle-sepolia',
      sponsorshipPolicy: 'always',
    });
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('type', 'paymasterClient');
  });

  it("'never' short-circuits before checking PIMLICO_API_KEY", () => {
    vi.unstubAllEnvs();
    expect(() =>
      createPaymasterClient({ chain: 'mantle-mainnet', sponsorshipPolicy: 'never' }),
    ).not.toThrow();
  });
});

describe('createPaymasterClient — URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes Pimlico sepolia URL when 'always' on mantle-sepolia", async () => {
    const { http } = await import('viem');
    createPaymasterClient({ chain: 'mantle-sepolia', sponsorshipPolicy: 'always' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(
      `https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=${TEST_PIMLICO_KEY}`,
    );
  });

  it("passes Pimlico mainnet URL when 'always' on mantle-mainnet", async () => {
    const { http } = await import('viem');
    createPaymasterClient({ chain: 'mantle-mainnet', sponsorshipPolicy: 'always' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(`https://api.pimlico.io/v2/mantle/rpc?apikey=${TEST_PIMLICO_KEY}`);
  });

  it('accepts apiKey override', async () => {
    vi.unstubAllEnvs();
    const { http } = await import('viem');
    createPaymasterClient({
      chain: 'mantle-sepolia',
      sponsorshipPolicy: 'always',
      apiKey: 'override-key',
    });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain('https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=override-key');
  });
});

describe('createPaymasterClient — input guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws ConfigError when PIMLICO_API_KEY missing and policy is 'always'", () => {
    vi.unstubAllEnvs();
    try {
      createPaymasterClient({ chain: 'mantle-sepolia', sponsorshipPolicy: 'always' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain("MissingEnvVar('PIMLICO_API_KEY')");
    }
  });

  it('throws ConfigError for unsupported chain with message content', () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
      createPaymasterClient({ chain: 'ethereum-mainnet' as any, sponsorshipPolicy: 'always' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain(
        "UnsupportedChain('ethereum-mainnet')",
      );
    }
  });

  it("maps viemCreatePaymasterClient sync throw to RpcError when policy is 'always'", async () => {
    const { createPaymasterClient: viemMock } = await import('viem/account-abstraction');
    vi.mocked(viemMock).mockImplementationOnce(() => {
      throw new TypeError('paymaster transport init failed');
    });
    expect(() =>
      createPaymasterClient({ chain: 'mantle-sepolia', sponsorshipPolicy: 'always' }),
    ).toThrowError(expect.objectContaining({ type: 'RpcError' }) as unknown as Error);
  });

  it('paymaster transport error message does not expose the API key', async () => {
    const { createPaymasterClient: viemMock } = await import('viem/account-abstraction');
    vi.mocked(viemMock).mockImplementationOnce(() => {
      throw new TypeError(
        `transport error https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=${TEST_PIMLICO_KEY}`,
      );
    });
    expect(() =>
      createPaymasterClient({ chain: 'mantle-sepolia', sponsorshipPolicy: 'always' }),
    ).toThrowError(
      expect.objectContaining({
        type: 'RpcError',
        message: expect.not.stringContaining(TEST_PIMLICO_KEY),
      }) as unknown as Error,
    );
  });
});
