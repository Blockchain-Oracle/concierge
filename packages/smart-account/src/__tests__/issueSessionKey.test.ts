import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { SessionKeySecret } from '../crypto/sessionKeySecret.ts';
import { issueSessionKey } from '../issueSessionKey.ts';
import type { CallPermission } from '../policies/callPolicy.ts';
import type { ConciergeAccount } from '../types.ts';

const AAVE_POOL = '0x1111111111111111111111111111111111111111' as Address;
const SUPPLY_SELECTOR = '0x617ba037' as Hex;
const KERNEL_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Address;
const _AGENT_ID = '00000000-0000-0000-0000-000000000001';

const PROVIDER = {
  sessionKey: {
    callPolicy: {
      permissions: [{ target: AAVE_POOL, selector: SUPPLY_SELECTOR } as CallPermission],
    },
  },
};

const CONCIERGE_ACCOUNT_STUB: ConciergeAccount = {
  smartAccountAddress: KERNEL_ADDR,
  kernelAccount: { address: KERNEL_ADDR } as ConciergeAccount['kernelAccount'],
  kernelClient: { chain: { id: 5003 } } as ConciergeAccount['kernelClient'],
};

// Stub viem RPC plumbing — unit tests don't need a live RPC.
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({ type: 'publicClient' }),
    http: vi.fn().mockReturnValue({ type: 'transport' }),
  };
});

vi.mock('@zerodev/permissions', () => ({
  toPermissionValidator: vi.fn().mockResolvedValue({
    getEnableData: async () => '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex,
    getIdentifier: () => '0x1234567890123456789012345678901234567890' as Hex,
    getEnableData_: async () => '0xdeadbeef' as Hex,
  }),
}));

vi.mock('@zerodev/permissions/signers', () => ({
  toECDSASigner: vi
    .fn()
    .mockImplementation(async ({ signer }: { signer: { address: Address } }) => ({
      account: signer,
      signerContractAddress: '0x0000000000000000000000000000000000000000' as Address,
      getSignerData: () => signer.address,
      getDummySignature: () => '0x' as Hex,
    })),
}));

vi.mock('@zerodev/sdk', () => ({
  getPluginsEnableTypedData: vi.fn().mockResolvedValue({
    domain: {
      name: 'Kernel',
      version: '0.3.1',
      chainId: 5003,
      verifyingContract: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
    types: {
      Enable: [
        { name: 'validationId', type: 'bytes21' },
        { name: 'nonce', type: 'uint32' },
        { name: 'hook', type: 'address' },
        { name: 'validatorData', type: 'bytes' },
        { name: 'hookData', type: 'bytes' },
        { name: 'selectorData', type: 'bytes' },
      ],
    },
    message: {
      validationId: `0x${'aa'.repeat(21)}` as Hex,
      nonce: 0,
      hook: '0x0000000000000000000000000000000000000000' as Address,
      validatorData: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex,
      hookData: '0x' as Hex,
      selectorData: `0x${'00'.repeat(24)}` as Hex,
    },
    primaryType: 'Enable' as const,
  }),
}));

vi.mock('@zerodev/sdk/accounts', () => ({
  getKernelV3Nonce: vi.fn().mockResolvedValue(0n),
  accountMetadata: vi.fn().mockResolvedValue({ nonce: 0n, name: 'Kernel', version: '0.3.1' }),
}));

vi.mock('@zerodev/sdk/constants', async () => {
  const actual =
    await vi.importActual<typeof import('@zerodev/sdk/constants')>('@zerodev/sdk/constants');
  return { ...actual, getEntryPoint: vi.fn().mockReturnValue({ version: '0.7', address: '0x' }) };
});

describe('issueSessionKey — EIP-712 typed-data signing', () => {
  it('returns sessionKeyAddress, encodedPolicy, enableTypedDataHash, EIP-712 signature recovering to owner', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const result = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    expect(result.sessionKeyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.sessionKeyPrivateKey).toBeInstanceOf(SessionKeySecret);
    expect(result.encodedPolicy).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(result.enableTypedDataHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    // Verify against the same typed-data ZeroDev produced.
    const { getPluginsEnableTypedData } = await import('@zerodev/sdk');
    // biome-ignore lint/suspicious/noExplicitAny: Typed-data shape from mock
    const typedData = await (getPluginsEnableTypedData as any).mock.results[0]?.value;
    expect(typedData).toBeDefined();
    expect(hashTypedData(typedData)).toBe(result.enableTypedDataHash);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature: result.signature });
    expect(recovered.toLowerCase()).toBe(ownerAccount.address.toLowerCase());
  });

  it('IssueSessionKeyResult.sessionKeyPrivateKey redacts on toString/toJSON (log safety)', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const result = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    expect(String(result.sessionKeyPrivateKey)).toBe('[SessionKeySecret REDACTED]');
    expect(JSON.stringify({ pk: result.sessionKeyPrivateKey })).toContain('REDACTED');
  });

  it('throws ConfigError for unsupported chain', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    try {
      await issueSessionKey({
        ownerAccount,
        conciergeAccount: CONCIERGE_ACCOUNT_STUB,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid chain input
        chain: 'ethereum-mainnet' as any,
        providers: [PROVIDER],
        spendingLimits: [],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('UnsupportedChain');
    }
  });

  it('throws ConfigError when validUntil <= validAfter', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const t = Math.floor(Date.now() / 1000);
    try {
      await issueSessionKey({
        ownerAccount,
        conciergeAccount: CONCIERGE_ACCOUNT_STUB,
        chain: 'mantle-sepolia',
        providers: [PROVIDER],
        spendingLimits: [],
        validAfter: t + 1000,
        validUntil: t + 500,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('validUntil');
    }
  });

  it('throws InvalidOwnerSignature when the owner signTypedData returns a signature from a different key', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const wrongAccount = privateKeyToAccount(generatePrivateKey());
    const malformedOwner = Object.assign(Object.create(Object.getPrototypeOf(ownerAccount)), {
      ...ownerAccount,
      signTypedData: wrongAccount.signTypedData,
    });
    try {
      await issueSessionKey({
        ownerAccount: malformedOwner,
        conciergeAccount: CONCIERGE_ACCOUNT_STUB,
        chain: 'mantle-sepolia',
        providers: [PROVIDER],
        spendingLimits: [],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('InvalidOwnerSignature');
      expect(String((e as ConciergeError).message)).toContain('signature recovery mismatch');
    }
  });

  it('default validUntil is ~7 days, validAfter is ~now', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const before = Math.floor(Date.now() / 1000);
    const result = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    const after = Math.floor(Date.now() / 1000);
    expect(result.validUntil).toBeGreaterThanOrEqual(before + 7 * 86400);
    expect(result.validUntil).toBeLessThanOrEqual(after + 7 * 86400);
    expect(result.validAfter).toBeGreaterThanOrEqual(before);
    expect(result.validAfter).toBeLessThanOrEqual(after);
  });
});
