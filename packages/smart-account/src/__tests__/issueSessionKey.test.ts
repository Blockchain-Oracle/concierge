import { randomBytes } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { keccak256, recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSessionKey } from '../issueSessionKey.ts';
import { loadSessionKey } from '../loadSessionKey.ts';
import { persistSessionKey } from '../persistSessionKey.ts';
import type { CallPermission } from '../policies/callPolicy.ts';

const AAVE_POOL = '0x1111111111111111111111111111111111111111' as Address;
const SUPPLY_SELECTOR = '0x617ba037' as Hex;

const PROVIDER = {
  sessionKey: {
    callPolicy: {
      permissions: [{ target: AAVE_POOL, selector: SUPPLY_SELECTOR } as CallPermission],
    },
  },
};

// Mock the heavy viem/zerodev plumbing that requires network in `issueSessionKey`.
// We stub `createPublicClient` and `toPermissionValidator` so unit tests don't need
// a real RPC endpoint.
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

vi.mock('@zerodev/sdk/constants', async () => {
  const actual =
    await vi.importActual<typeof import('@zerodev/sdk/constants')>('@zerodev/sdk/constants');
  return { ...actual, getEntryPoint: vi.fn().mockReturnValue({ version: '0.7', address: '0x' }) };
});

describe('issueSessionKey — happy path', () => {
  it('returns sessionKeyAddress, encodedPolicy (non-empty hex), and a valid owner signature', async () => {
    const ownerPk = generatePrivateKey();
    const ownerAccount = privateKeyToAccount(ownerPk);
    const result = await issueSessionKey({
      ownerAccount,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    expect(result.sessionKeyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.sessionKeyPrivateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.encodedPolicy).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(result.signature).toMatch(/^0x[0-9a-fA-F]{130}$/); // 65 bytes
    const recovered = await recoverMessageAddress({
      message: { raw: keccak256(result.encodedPolicy) },
      signature: result.signature,
    });
    expect(recovered.toLowerCase()).toBe(ownerAccount.address.toLowerCase());
  });

  it('defaults validUntil to ~7 days from now', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const before = Math.floor(Date.now() / 1000);
    const result = await issueSessionKey({
      ownerAccount,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    const expectedValidUntil = before + 7 * 24 * 60 * 60;
    expect(result.validUntil).toBeGreaterThanOrEqual(expectedValidUntil - 5);
    expect(result.validUntil).toBeLessThanOrEqual(expectedValidUntil + 5);
  });

  it('throws ConfigError for unsupported chain', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    try {
      await issueSessionKey({
        ownerAccount,
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

  it('throws InvalidOwnerSignature when the owner signMessage callback returns garbage', async () => {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    // Override signMessage to return a valid-shape but wrong signature
    const wrongPk = generatePrivateKey();
    const wrongAccount = privateKeyToAccount(wrongPk);
    const malformedOwner = {
      ...ownerAccount,
      signMessage: wrongAccount.signMessage,
    };
    try {
      await issueSessionKey({
        ownerAccount: malformedOwner,
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
});

// In-memory DB stub mimicking the Drizzle surface we use: insert().values().returning(),
// and select().from().where().limit(). Mirrors @concierge/db schema fields strictly.
interface StubRow {
  id: string;
  agentId: string;
  publicAddress: Address;
  encryptedPrivateKey: Buffer;
  policyJson: unknown;
  signature: string;
  validUntil: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

function makeStubDb(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub DbClient shape
  db: any;
  rows: StubRow[];
} {
  const rows: StubRow[] = [];
  let nextId = 1;
  const db = {
    insert: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: insert payload
      values: (v: any) => ({
        returning: async () => {
          const row: StubRow = {
            id: `sk-${nextId++}`,
            agentId: v.agentId,
            publicAddress: v.publicAddress,
            encryptedPrivateKey: v.encryptedPrivateKey,
            policyJson: v.policyJson,
            signature: v.signature,
            validUntil: v.validUntil,
            revokedAt: null,
            createdAt: new Date(),
          };
          rows.push(row);
          return [{ id: row.id, createdAt: row.createdAt }];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        // biome-ignore lint/suspicious/noExplicitAny: where predicate object from drizzle eq()
        where: (_w: any) => ({
          // biome-ignore lint/suspicious/noExplicitAny: where predicate object captures the id internally
          limit: async (_n: number) => rows.slice(),
        }),
      }),
    }),
  };
  return { db, rows };
}

describe('persistSessionKey + loadSessionKey roundtrip', () => {
  let originalKey: Hex;
  let encryptionKey: Buffer;

  beforeEach(() => {
    encryptionKey = randomBytes(32);
    originalKey = generatePrivateKey();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function issueAndPersist() {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const issued = await issueSessionKey({
      ownerAccount,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    // Override the private key so we can compare round-trip exactly.
    const issuedWithKnownKey = { ...issued, sessionKeyPrivateKey: originalKey };
    const { db, rows } = makeStubDb();
    const persisted = await persistSessionKey({
      db,
      agentId: '00000000-0000-0000-0000-000000000001',
      sessionKey: issuedWithKnownKey,
      encryptionKey,
    });
    return { db, rows, persisted };
  }

  it('encrypts the private key (stored value != plaintext) and returns a valid sessionKeyId', async () => {
    const { rows, persisted } = await issueAndPersist();
    expect(persisted.sessionKeyId).toMatch(/^sk-/);
    expect(persisted.persistedAt).toBeInstanceOf(Date);
    const row = rows[0];
    expect(row).toBeDefined();
    // Encrypted bytea must NOT equal the plaintext bytes
    const plaintextBytes = Buffer.from(originalKey.slice(2), 'hex');
    expect(row?.encryptedPrivateKey.equals(plaintextBytes)).toBe(false);
    // Envelope length is IV(12) + tag(16) + ciphertext(32) = 60 bytes
    expect(row?.encryptedPrivateKey.length).toBe(60);
  });

  it('loadSessionKey decrypts back to the original private key with the correct encryption key', async () => {
    const { db, persisted } = await issueAndPersist();
    const loaded = await loadSessionKey({
      db,
      sessionKeyId: persisted.sessionKeyId,
      encryptionKey,
    });
    expect(loaded.privateKey).toBe(originalKey);
    expect(loaded.encodedPolicy).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(loaded.signature).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(loaded.validUntil).toBeInstanceOf(Date);
  });

  it('throws DecryptionFailed when the wrong encryption key is provided', async () => {
    const { db, persisted } = await issueAndPersist();
    const wrongKey = randomBytes(32);
    try {
      await loadSessionKey({ db, sessionKeyId: persisted.sessionKeyId, encryptionKey: wrongKey });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('DecryptionFailed');
    }
  });

  it('throws SessionKeyExpired when validUntil has passed', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    // Force-expire the row
    if (rows[0]) rows[0].validUntil = new Date(Date.now() - 1000);
    try {
      await loadSessionKey({ db, sessionKeyId: persisted.sessionKeyId, encryptionKey });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('SessionKeyExpired');
    }
  });

  it('throws SessionKeyRevoked when revokedAt is set', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    if (rows[0]) rows[0].revokedAt = new Date();
    try {
      await loadSessionKey({ db, sessionKeyId: persisted.sessionKeyId, encryptionKey });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('SessionKeyRevoked');
    }
  });

  it('throws ConfigError when the encryption key is not 32 bytes', async () => {
    const { db, rows: _rows } = makeStubDb();
    try {
      await persistSessionKey({
        db,
        agentId: '00000000-0000-0000-0000-000000000001',
        sessionKey: {
          sessionKeyAddress: '0xaaaa000000000000000000000000000000000000' as Address,
          sessionKeyPrivateKey: originalKey,
          encodedPolicy: '0xdead' as Hex,
          signature: '0xbeef' as Hex,
          validUntil: Math.floor(Date.now() / 1000) + 3600,
          validAfter: Math.floor(Date.now() / 1000),
        },
        encryptionKey: randomBytes(16), // wrong size
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('32 bytes');
    }
  });
});
