import { randomBytes } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

interface StubRow {
  id: string;
  agentId: string;
  publicAddress: Address;
  encryptedPrivateKey: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: stub policyJson shape
  policyJson: any;
  signature: string;
  validUntil: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

function makeStubDb() {
  const rows: StubRow[] = [];
  let nextId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: DbClient stub
  const db: any = {
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
        // biome-ignore lint/suspicious/noExplicitAny: drizzle eq()
        where: (w: any) => {
          let targetId: string | undefined;
          const chunks = (w?.queryChunks ?? []) as unknown[];
          for (const c of chunks) {
            // biome-ignore lint/suspicious/noExplicitAny: drizzle internals
            if (typeof c === 'object' && c !== null && typeof (c as any).value === 'string') {
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

describe('story-53 round-2 — validUntil authoritative source + Zod drift', () => {
  let encryptionKey: Buffer;

  beforeEach(() => {
    encryptionKey = randomBytes(32);
  });

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
    return { db, rows, persisted };
  }

  it('throws SessionKeyExpired when validUntil has passed (consistent column + policyJson)', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    if (rows[0]) {
      const past = Math.floor((Date.now() - 1000) / 1000);
      rows[0].validUntil = new Date(past * 1000);
      rows[0].policyJson.validUntil = past;
    }
    await expect(
      loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'SessionKeyExpired',
    );
  });

  it('throws DecryptionFailed on validUntil column drift (DB-write attacker)', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    if (rows[0]) rows[0].validUntil = new Date(Date.now() + 1e10);
    await expect(
      loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'DecryptionFailed' &&
        String(e.message).includes('validUntil drift'),
    );
  });

  it('throws DecryptionFailed when policyJson shape drifts (Zod parse fail)', async () => {
    const { db, persisted, rows } = await issueAndPersist();
    if (rows[0]) rows[0].policyJson = { encodedPolicy: 'not-hex' };
    await expect(
      loadSessionKey({
        db,
        sessionKeyId: persisted.sessionKeyId,
        expectedAgentId: AGENT_ID,
        encryptionKey,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'DecryptionFailed' &&
        String(e.message).includes('shape drift'),
    );
  });
});
