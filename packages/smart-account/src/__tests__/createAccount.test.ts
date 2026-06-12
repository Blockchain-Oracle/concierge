import { ConciergeError } from '@concierge/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTRYPOINT_V07_ADDRESS } from '../constants.ts';

const TEST_PIMLICO_KEY = 'test-pimlico-api-key';

// Stable mock address derived from owner to simulate CREATE2 determinism
function deterministicAddress(owner: `0x${string}`): `0x${string}` {
  return `0x${owner.slice(2, 42).padStart(40, '0')}` as `0x${string}`;
}

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({ type: 'publicClient' }),
    http: vi.fn().mockImplementation((url: string) => ({ type: 'transport', url })),
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
          // Mirror ZeroDev's CREATE2 behavior: address is deterministic from validator (which contains owner)
          const sudo = params?.plugins?.sudo as { type: string } | undefined;
          const base = params?.address ?? (`0x${'aa'.repeat(20)}` as `0x${string}`);
          const addr = sudo ? deterministicAddress(base) : base;
          return Promise.resolve({ address: addr, type: 'kernelAccount' });
        },
      ),
    createKernelAccountClient: vi.fn().mockReturnValue({ type: 'kernelClient' }),
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
import { createConciergeAccount } from '../createAccount.ts';

const OWNER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
// biome-ignore lint/suspicious/noExplicitAny: LocalAccount minimal stub for test injection
const MOCK_OWNER = { address: OWNER_ADDRESS, sign: vi.fn() } as any;

describe('createConciergeAccount — return shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('returns smartAccountAddress, kernelAccount, and clientPromise', async () => {
    const result = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    expect(result).toHaveProperty('smartAccountAddress');
    expect(result).toHaveProperty('kernelAccount');
    expect(result).toHaveProperty('clientPromise');
  });

  it('smartAccountAddress is a valid 0x hex address', async () => {
    const result = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    expect(result.smartAccountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('clientPromise is a Promise', async () => {
    const result = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    expect(result.clientPromise).toBeInstanceOf(Promise);
  });

  it('clientPromise resolves to the kernel client', async () => {
    const result = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    const client = await result.clientPromise;
    expect(client).toMatchObject({ type: 'kernelClient' });
  });
});

describe('createConciergeAccount — CREATE2 determinism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('same owner + chain returns same smartAccountAddress', async () => {
    const r1 = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    const r2 = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    expect(r1.smartAccountAddress).toBe(r2.smartAccountAddress);
  });

  it('same owner on different chains may produce different addresses', async () => {
    const rSepolia = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    const rMainnet = await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-mainnet' });
    // Both are valid addresses; they may coincide via CREATE2 but the code must not break
    expect(rSepolia.smartAccountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(rMainnet.smartAccountAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('createConciergeAccount — ZeroDev parameters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('calls getEntryPoint with "0.7"', async () => {
    const { getEntryPoint } = await import('@zerodev/sdk/constants');
    await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    expect(getEntryPoint).toHaveBeenCalledWith('0.7');
  });

  it('getEntryPoint("0.7") returns address matching canonical EntryPoint v0.7', async () => {
    const { getEntryPoint } = await import('@zerodev/sdk/constants');
    const ep = getEntryPoint('0.7');
    expect(ep.address).toBe(ENTRYPOINT_V07_ADDRESS);
  });

  it('createKernelAccount is called with KERNEL_V3_1', async () => {
    const { createKernelAccount } = await import('@zerodev/sdk');
    const { KERNEL_V3_1 } = await import('@zerodev/sdk/constants');
    await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    expect(createKernelAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kernelVersion: KERNEL_V3_1 }),
    );
  });

  it('KERNEL_V3_1 constant equals "0.3.1"', async () => {
    const { KERNEL_V3_1 } = await import('@zerodev/sdk/constants');
    expect(KERNEL_V3_1).toBe('0.3.1');
  });
});

describe('createConciergeAccount — bundler URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('passes Pimlico mainnet URL with API key to createKernelAccountClient', async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    const { http } = await import('viem');
    await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-mainnet' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(`https://api.pimlico.io/v2/mantle/rpc?apikey=${TEST_PIMLICO_KEY}`);
    expect(createKernelAccountClient).toHaveBeenCalled();
  });

  it('passes Pimlico sepolia URL with API key to createKernelAccountClient', async () => {
    const { http } = await import('viem');
    await createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' });
    const httpCalls = vi.mocked(http).mock.calls.map((c) => c[0]);
    expect(httpCalls).toContain(
      `https://api.pimlico.io/v2/mantle-sepolia/rpc?apikey=${TEST_PIMLICO_KEY}`,
    );
  });

  it('throws ConfigError when PIMLICO_API_KEY is missing', async () => {
    vi.unstubAllEnvs();
    await expect(
      createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes("MissingEnvVar('PIMLICO_API_KEY')"),
    );
  });
});

describe('createConciergeAccount — chain guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('throws ConciergeError(ConfigError) for unsupported chain', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
      createConciergeAccount({ owner: MOCK_OWNER, chain: 'ethereum-mainnet' as any }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes("UnsupportedChain('ethereum-mainnet')"),
    );
  });

  it('accepts mantle-mainnet without throwing', async () => {
    await expect(
      createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-mainnet' }),
    ).resolves.toHaveProperty('smartAccountAddress');
  });

  it('accepts mantle-sepolia without throwing', async () => {
    await expect(
      createConciergeAccount({ owner: MOCK_OWNER, chain: 'mantle-sepolia' }),
    ).resolves.toHaveProperty('smartAccountAddress');
  });
});

const EXISTING_ADDRESS = '0x1234567890123456789012345678901234567890' as const;

describe('connectToConciergeAccount — shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('returns same shape as createConciergeAccount', async () => {
    const result = await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    expect(result).toHaveProperty('smartAccountAddress');
    expect(result).toHaveProperty('kernelAccount');
    expect(result).toHaveProperty('clientPromise');
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
});

describe('connectToConciergeAccount — bundler URL + guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });

  it('passes Pimlico sepolia URL with API key for connect', async () => {
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

  it('throws ConciergeError(ConfigError) for unsupported chain', async () => {
    await expect(
      connectToConciergeAccount({
        address: EXISTING_ADDRESS,
        owner: MOCK_OWNER,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
        chain: 'ethereum-mainnet' as any,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
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

describe('ENTRYPOINT_V07_ADDRESS constant', () => {
  it('matches canonical EntryPoint v0.7 address', () => {
    expect(ENTRYPOINT_V07_ADDRESS).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
  });
});
