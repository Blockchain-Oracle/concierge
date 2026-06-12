import { randomBytes } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSessionKey } from '../issueSessionKey.ts';
import { loadSessionKey } from '../loadSessionKey.ts';
import { persistSessionKey } from '../persistSessionKey.ts';
import type { CallPermission } from '../policies/callPolicy.ts';
import type { ConciergeAccount } from '../types.ts';

const AAVE_POOL = '0x1111111111111111111111111111111111111111' as Address;
const SUPPLY_SELECTOR = '0x617ba037' as Hex;
const KERNEL_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Address;
const AGENT_ID = '00000000-0000-0000-0000-000000000001';

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

// Predicate-aware stub DB: where() captures the drizzle eq()-produced token,
// limit() honors the filter so multi-row tests can target a specific row.
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
        // Drizzle's eq() returns an SQL object carrying both sides. We sniff
        // the right-hand value (the id literal) so the stub respects the predicate.
        // biome-ignore lint/suspicious/noExplicitAny: where predicate from drizzle eq()
        where: (w: any) => {
          // eq(...) returns an object whose .queryChunks contain a `Param` carrying
          // the value. Walk it to find the literal id we filtered on.
          let targetId: string | undefined;
          const chunks = (w?.queryChunks ?? []) as unknown[];
          for (const c of chunks) {
            if (
              typeof c === 'object' &&
              c !== null &&
              // biome-ignore lint/suspicious/noExplicitAny: drizzle internals
              typeof (c as any).value === 'string'
            ) {
              // biome-ignore lint/suspicious/noExplicitAny: drizzle internals
              targetId = (c as any).value;
              break;
            }
          }
          return {
            limit: async (_n: number) => (targetId ? rows.filter((r) => r.id === targetId) : []),
          };
        },
      }),
    }),
  };
  return { db, rows };
}

describe('persistSessionKey + loadSessionKey — kill switches + config errors', () => {
  let encryptionKey: Buffer;

  beforeEach(() => {
    encryptionKey = randomBytes(32);
  });
  afterEach(() => vi.restoreAllMocks());

  async function issueAndPersist() {
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const issued = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    const { db, rows } = makeStubDb();
    const persisted = await persistSessionKey({
      db,
      agentId: AGENT_ID,
      sessionKey: issued,
      encryptionKey,
    });
    return { db, rows, persisted, issued };
  }

  it('throws DecryptionFailed for envelope of wrong length', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    if (rows[0]) rows[0].encryptedPrivateKey = Buffer.alloc(10);
    try {
      await loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('DecryptionFailed');
      expect(String((e as ConciergeError).message)).toContain('envelope length');
    }
  });

  it('throws SessionKeyExpired when validUntil has passed', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    if (rows[0]) rows[0].validUntil = new Date(Date.now() - 1000);
    try {
      await loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      });
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
      await loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('SessionKeyRevoked');
    }
  });

  it('throws SessionKeyExpired when validAfter is in the future (not-yet-valid kill switch)', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    const row = rows[0];
    expect(row).toBeDefined();
    if (row) {
      // biome-ignore lint/suspicious/noExplicitAny: stub row policyJson is unknown-typed
      const pj = row.policyJson as any;
      pj.validAfter = Math.floor(Date.now() / 1000) + 3600;
    }
    try {
      await loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('SessionKeyExpired');
      expect(String((e as ConciergeError).message)).toContain('not yet valid');
    }
  });

  it('throws ConfigError on not-found (predicate honored)', async () => {
    const { db, persisted: _persisted } = await issueAndPersist();
    try {
      await loadSessionKey({
        db,
        sessionKeyId: 'sk-does-not-exist',
        expectedAgentId: AGENT_ID,
        encryptionKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('not found');
    }
  });
  it('multi-row stub: persists A then B in same DB, loadSessionKey(B.id) returns B, not A', async () => {
    const { db, rows } = makeStubDb();
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const issuedA = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    const persistedA = await persistSessionKey({
      db,
      agentId: AGENT_ID,
      sessionKey: issuedA,
      encryptionKey,
    });
    const issuedB = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    const persistedB = await persistSessionKey({
      db,
      agentId: AGENT_ID,
      sessionKey: issuedB,
      encryptionKey,
    });
    expect(rows.length).toBe(2);
    expect(persistedA.sessionKeyId).not.toBe(persistedB.sessionKeyId);
    // Loading B's id MUST return B's row, NOT A's — the predicate is honored.
    const loadedB = await loadSessionKey({
      db,
      sessionKeyId: persistedB.sessionKeyId,
      expectedAgentId: AGENT_ID,
      encryptionKey,
    });
    expect(loadedB.privateKey.consume()).toHaveLength(32);
    // Verify A is still loadable too — both rows distinguishable.
    const loadedA = await loadSessionKey({
      db,
      sessionKeyId: persistedA.sessionKeyId,
      expectedAgentId: AGENT_ID,
      encryptionKey,
    });
    expect(loadedA.privateKey.consume()).toHaveLength(32);
  });

  it('throws ConfigError when encryptionKey is not 32 bytes (persist + load)', async () => {
    const { db } = makeStubDb();
    const ownerAccount = privateKeyToAccount(generatePrivateKey());
    const issued = await issueSessionKey({
      ownerAccount,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    for (const cfg of [
      () =>
        persistSessionKey({
          db,
          agentId: AGENT_ID,
          sessionKey: issued,
          encryptionKey: randomBytes(16),
        }),
      () =>
        loadSessionKey({
          db,
          sessionKeyId: 'sk-1',
          expectedAgentId: AGENT_ID,
          encryptionKey: randomBytes(16),
        }),
    ]) {
      try {
        await cfg();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ConciergeError);
        expect((e as ConciergeError).type).toBe('ConfigError');
        expect(String((e as ConciergeError).message)).toContain('32 bytes');
      }
    }
  });
  it('throws on double-persist (SessionKeySecret already consumed)', async () => {
    const { db } = makeStubDb();
    const owner = privateKeyToAccount(generatePrivateKey());
    const issued = await issueSessionKey({
      ownerAccount: owner,
      conciergeAccount: CONCIERGE_ACCOUNT_STUB,
      chain: 'mantle-sepolia',
      providers: [PROVIDER],
      spendingLimits: [],
    });
    await persistSessionKey({ db, agentId: AGENT_ID, sessionKey: issued, encryptionKey });
    await expect(
      persistSessionKey({ db, agentId: AGENT_ID, sessionKey: issued, encryptionKey }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        String(e.message).includes('already consumed'),
    );
  });
});
