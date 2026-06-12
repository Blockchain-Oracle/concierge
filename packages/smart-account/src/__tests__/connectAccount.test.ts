import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTRYPOINT_V07_ADDRESS } from '../constants.ts';

const TEST_PIMLICO_KEY = 'test-pimlico-api-key';
const EXISTING_ADDRESS = '0x1234567890123456789012345678901234567890' as const;

function deterministicAddress(owner: `0x${string}`): `0x${string}` {
  return `0x${owner.slice(2, 42).padStart(40, '0')}` as `0x${string}`;
}

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({ type: 'publicClient' }),
    http: vi.fn().mockImplementation((url: string) => ({ type: 'transport', url })),
    isAddress: vi.fn().mockImplementation((addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr)),
  };
});

vi.mock('@zerodev/ecdsa-validator', () => ({
  signerToEcdsaValidator: vi.fn().mockResolvedValue({ type: 'ecdsaValidator' }),
}));

vi.mock('@zerodev/sdk', async () => {
  const actual = await vi.importActual<typeof import('@zerodev/sdk')>('@zerodev/sdk');
  return {
    ...actual,
    createKernelAccount: vi
      .fn()
      .mockImplementation(
        (_client: unknown, params: { plugins: { sudo: unknown }; address?: `0x${string}` }) => {
          const sudo = params?.plugins?.sudo as { type: string } | undefined;
          const base = params?.address ?? (`0x${'aa'.repeat(20)}` as `0x${string}`);
          const addr = sudo ? deterministicAddress(base) : base;
          return Promise.resolve({ address: addr, type: 'kernelAccount' });
        },
      ),
    createKernelAccountClient: vi
      .fn()
      .mockReturnValue({ type: 'kernelClient', chain: { id: 5003 } }),
  };
});

vi.mock('viem/account-abstraction', async () => {
  const actual = await vi.importActual<typeof import('viem/account-abstraction')>(
    'viem/account-abstraction',
  );
  return {
    ...actual,
    createPaymasterClient: vi.fn().mockReturnValue({
      type: 'paymasterClient',
      getPaymasterData: vi.fn(),
      getPaymasterStubData: vi.fn(),
    }),
  };
});

vi.mock('@zerodev/sdk/constants', async () => {
  const actual =
    await vi.importActual<typeof import('@zerodev/sdk/constants')>('@zerodev/sdk/constants');
  return {
    ...actual,
    KERNEL_V3_1: '0.3.1',
    getEntryPoint: vi.fn().mockImplementation((version: string) => ({
      version,
      address: ENTRYPOINT_V07_ADDRESS,
    })),
  };
});

import { connectToConciergeAccount } from '../connectAccount.ts';

const OWNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
// biome-ignore lint/suspicious/noExplicitAny: LocalAccount minimal stub for test injection
const MOCK_OWNER = { address: OWNER_ADDRESS, sign: vi.fn() } as any;

describe('connectToConciergeAccount — shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns same shape as createConciergeAccount', async () => {
    const result = await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    expect(result).toHaveProperty('smartAccountAddress');
    expect(result).toHaveProperty('kernelAccount');
    expect(result).toHaveProperty('kernelClient');
  });

  it('smartAccountAddress equals the provided address', async () => {
    const result = await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    expect(result.smartAccountAddress.toLowerCase()).toBe(EXISTING_ADDRESS.toLowerCase());
  });

  it('passes address to createKernelAccount', async () => {
    const { createKernelAccount } = await import('@zerodev/sdk');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    expect(createKernelAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ address: EXISTING_ADDRESS }),
    );
  });

  it('kernelClient satisfies KernelClientStub — chain.id is a number', async () => {
    const result = await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    // biome-ignore lint/suspicious/noExplicitAny: asserting KernelClientStub shape on mock return
    expect(typeof (result.kernelClient as any).chain?.id).toBe('number');
  });
});

describe('connectToConciergeAccount — bundler URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes Pimlico sepolia URL with API key', async () => {
    const { http } = await import('viem');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(
      `https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=${TEST_PIMLICO_KEY}`,
    );
  });

  it('passes Pimlico mainnet URL with API key', async () => {
    const { http } = await import('viem');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-mainnet',
    });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(`https://api.pimlico.io/v2/mantle/rpc?apikey=${TEST_PIMLICO_KEY}`);
  });

  it('accepts apiKey override instead of PIMLICO_API_KEY env var', async () => {
    vi.unstubAllEnvs();
    const { http } = await import('viem');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
      apiKey: 'override-key',
    });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain('https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=override-key');
  });
});

describe('connectToConciergeAccount — input guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws ConfigError for invalid address format', async () => {
    await expect(
      connectToConciergeAccount({
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid address input
        address: 'not-an-address' as any,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes('InvalidAddress'),
    );
  });

  it('throws ConciergeError(ConfigError) for unsupported chain', async () => {
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
        chain: 'ethereum-mainnet' as any,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes("UnsupportedChain('ethereum-mainnet')") &&
        String(e.message).includes('connectToConciergeAccount'),
    );
  });

  it('throws ConfigError when PIMLICO_API_KEY is missing', async () => {
    vi.unstubAllEnvs();
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes("MissingEnvVar('PIMLICO_API_KEY')"),
    );
  });
});

describe('connectToConciergeAccount — rpcWrap error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps signerToEcdsaValidator rejection to ConciergeError(RpcError)', async () => {
    const { signerToEcdsaValidator } = await import('@zerodev/ecdsa-validator');
    const original = new Error('network timeout');
    vi.mocked(signerToEcdsaValidator).mockRejectedValueOnce(original);
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError' && e.cause === original,
    );
  });

  it('maps createKernelAccount rejection to ConciergeError(RpcError)', async () => {
    const { createKernelAccount } = await import('@zerodev/sdk');
    const original = new Error('rpc failed');
    vi.mocked(createKernelAccount).mockRejectedValueOnce(original);
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError' && e.cause === original,
    );
  });

  it('maps synchronous createKernelAccountClient throw to RpcError', async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    const original = new TypeError('sync client init failure');
    vi.mocked(createKernelAccountClient).mockImplementationOnce(() => {
      throw original;
    });
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError' && e.cause === original,
    );
  });
});

describe('connectToConciergeAccount — security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('kernel client init error message does not expose the API key', async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    vi.mocked(createKernelAccountClient).mockImplementationOnce(() => {
      throw new TypeError(
        `transport error https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=${TEST_PIMLICO_KEY}`,
      );
    });
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'RpcError' &&
        !String(e.message).includes(TEST_PIMLICO_KEY) &&
        // biome-ignore lint/suspicious/noExplicitAny: checking cause.message for API key leak
        !String((e as any).cause?.message ?? '').includes(TEST_PIMLICO_KEY) &&
        // biome-ignore lint/suspicious/noExplicitAny: checking cause.stack for API key leak
        !String((e as any).cause?.stack ?? '').includes(TEST_PIMLICO_KEY),
    );
  });
});

describe('connectToConciergeAccount — address consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws ConfigError when kernelAccount.address does not match supplied address', async () => {
    const { createKernelAccount } = await import('@zerodev/sdk');
    const mismatchedAddress = '0xDeAdBeEf00000000000000000000000000000000' as const;
    vi.mocked(createKernelAccount).mockResolvedValueOnce({
      address: mismatchedAddress,
      // biome-ignore lint/suspicious/noExplicitAny: minimal KernelAccount stub for mismatch test
    } as any);
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes('address mismatch'),
    );
  });

  it('throws ConfigError when kernelAccount.address is undefined (malformed SDK response)', async () => {
    const { createKernelAccount } = await import('@zerodev/sdk');
    // biome-ignore lint/suspicious/noExplicitAny: simulating malformed SDK response with no address
    vi.mocked(createKernelAccount).mockResolvedValueOnce({ address: undefined } as any);
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        chain: 'mantle-sepolia',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes('kernel account returned no address'),
    );
  });
});
