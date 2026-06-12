import { randomBytes } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionKeySecret } from '../crypto/sessionKeySecret.ts';
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

describe('persistSessionKey + loadSessionKey roundtrip (AAD-bound, agent-bound)', () => {
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

  it('encrypts the private key (stored bytea != plaintext) and produces a 60-byte envelope', async () => {
    const { rows, persisted } = await issueAndPersist();
    expect(persisted.sessionKeyId).toMatch(/^sk-/);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.encryptedPrivateKey.length).toBe(60); // IV(12) + tag(16) + ciphertext(32)
    // Trivially unequal-to-zeros (encryption produces high-entropy bytes)
    expect(row?.encryptedPrivateKey.equals(Buffer.alloc(60))).toBe(false);
  });

  it('loadSessionKey returns a SessionKeySecret that consumes to the original 32-byte key', async () => {
    const { db, persisted } = await issueAndPersist();
    const loaded = await loadSessionKey({
      db,
      sessionKeyId: persisted.sessionKeyId,
      expectedAgentId: AGENT_ID,
      encryptionKey,
    });
    expect(loaded.privateKey).toBeInstanceOf(SessionKeySecret);
    const bytes = loaded.privateKey.consume();
    expect(bytes).toHaveLength(32);
    expect(loaded.encodedPolicy).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(loaded.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(loaded.enableTypedDataHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(loaded.validUntil).toBeInstanceOf(Date);
    expect(loaded.validAfter).toBeGreaterThan(0);
  });

  it('throws DecryptionFailed for wrong encryption key', async () => {
    const { db, persisted } = await issueAndPersist();
    const wrongKey = randomBytes(32);
    try {
      await loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey: wrongKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('DecryptionFailed');
    }
  });

  it('throws DecryptionFailed when expectedAgentId does not match row (agent binding)', async () => {
    const { db, persisted } = await issueAndPersist();
    try {
      await loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: '99999999-9999-9999-9999-999999999999',
        encryptionKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('DecryptionFailed');
      expect(String((e as ConciergeError).message)).toContain('agent binding');
    }
  });

  it('throws DecryptionFailed when AAD tampering would occur (envelope swap detection)', async () => {
    const a = await issueAndPersist();
    const b = await issueAndPersist();
    // Simulate a DB-write attacker swapping a's envelope into b's row
    if (a.rows[0] && b.rows[0]) {
      b.rows[0].encryptedPrivateKey = a.rows[0].encryptedPrivateKey;
    }
    try {
      await loadSessionKey({
        db: b.db,
        sessionKeyId: b.persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('DecryptionFailed');
    }
  });
});
