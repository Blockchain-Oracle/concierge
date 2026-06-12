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

describe('connectToConciergeAccount — paymaster defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('wires paymaster for mantle-sepolia by default', async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
    });
    expect(createKernelAccountClient).toHaveBeenCalledWith(
      expect.objectContaining({
        paymaster: expect.objectContaining({
          getPaymasterData: expect.any(Function),
          getPaymasterStubData: expect.any(Function),
        }),
      }),
    );
  });

  it('does not wire paymaster for mantle-mainnet by default', async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-mainnet',
    });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args for assertion
    const callArg = vi.mocked(createKernelAccountClient).mock.calls[0]?.[0] as any;
    // biome-ignore lint/complexity/useLiteralKeys: any-typed access — bracket notation avoids TS4111
    expect(callArg?.['paymaster']).toBeUndefined();
  });
});

describe('connectToConciergeAccount — paymaster overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PIMLICO_API_KEY', TEST_PIMLICO_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("explicit paymaster: 'none' skips wiring on mantle-sepolia", async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-sepolia',
      paymaster: 'none',
    });
    // biome-ignore lint/suspicious/noExplicitAny: accessing mock call args for assertion
    const callArg = vi.mocked(createKernelAccountClient).mock.calls[0]?.[0] as any;
    // biome-ignore lint/complexity/useLiteralKeys: any-typed access — bracket notation avoids TS4111
    expect(callArg?.['paymaster']).toBeUndefined();
  });

  it("explicit paymaster: 'pimlico' wires paymaster on mantle-mainnet", async () => {
    const { createKernelAccountClient } = await import('@zerodev/sdk');
    await connectToConciergeAccount({
      address: EXISTING_ADDRESS,
      owner: MOCK_OWNER,
      chain: 'mantle-mainnet',
      paymaster: 'pimlico',
    });
    expect(createKernelAccountClient).toHaveBeenCalledWith(
      expect.objectContaining({
        paymaster: expect.objectContaining({
          getPaymasterData: expect.any(Function),
          getPaymasterStubData: expect.any(Function),
        }),
      }),
    );
  });
});
