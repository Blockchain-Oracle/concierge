import { ConciergeError } from '@concierge/sdk';
import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionNotFoundError,
  type TransactionSerializable,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueue, markSigned } from '../queue.ts';
import { sanitizeError, sanitizeMessage } from '../sanitize.ts';
import { sendSignedTx } from '../sender.ts';
import { BASE_ENQ, CHAIN_ID, DATA, makeDb, TO, TX_HASH, USER_ID, VALUE } from './_eoaStub.ts';

async function signEip1559(
  account: ReturnType<typeof privateKeyToAccount>,
  overrides: Partial<TransactionSerializable> = {},
): Promise<Hex> {
  const tx: TransactionSerializable = {
    chainId: CHAIN_ID,
    to: TO,
    value: BigInt(VALUE),
    data: DATA,
    nonce: 0,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gas: 21_000n,
    type: 'eip1559',
    ...overrides,
  };
  return account.signTransaction(tx);
}

async function signLegacy(
  account: ReturnType<typeof privateKeyToAccount>,
  overrides: Partial<TransactionSerializable> = {},
): Promise<Hex> {
  const tx: TransactionSerializable = {
    chainId: CHAIN_ID,
    to: TO,
    value: BigInt(VALUE),
    data: DATA,
    nonce: 0,
    gasPrice: 1_000_000_000n,
    gas: 21_000n,
    type: 'legacy',
    ...overrides,
  };
  return account.signTransaction(tx);
}

async function signEip2930(
  account: ReturnType<typeof privateKeyToAccount>,
  overrides: Partial<TransactionSerializable> = {},
): Promise<Hex> {
  const tx: TransactionSerializable = {
    chainId: CHAIN_ID,
    to: TO,
    value: BigInt(VALUE),
    data: DATA,
    nonce: 0,
    gasPrice: 1_000_000_000n,
    gas: 21_000n,
    type: 'eip2930',
    accessList: [],
    ...overrides,
  };
  return account.signTransaction(tx);
}

function makePublicClient(opts: {
  sendThrows?: Error;
  receiptStatus?: 'success' | 'reverted';
  receiptThrows?: Error;
  getTransactionResult?: 'found' | 'not-found' | 'rpc-outage';
}): PublicClient {
  // biome-ignore lint/suspicious/noExplicitAny: viem stub
  const stub: any = {
    sendRawTransaction: vi.fn(async () => {
      if (opts.sendThrows) throw opts.sendThrows;
      return TX_HASH;
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      if (opts.receiptThrows) throw opts.receiptThrows;
      return {
        status: opts.receiptStatus ?? 'success',
        blockNumber: 9999n,
        transactionHash: TX_HASH,
      };
    }),
    getTransaction: vi.fn(async () => {
      if (opts.getTransactionResult === 'not-found') {
        throw new TransactionNotFoundError({ hash: TX_HASH });
      }
      if (opts.getTransactionResult === 'rpc-outage') {
        throw new Error('Pimlico 502 upstream');
      }
      return { hash: TX_HASH };
    }),
  };
  return stub as PublicClient;
}

describe('sendSignedTx round-2: tx-type lock + accessList + reconcile (story-55 post-merge)', () => {
  let db: ReturnType<typeof makeDb>['db'];
  let queueId: string;
  let signer: ReturnType<typeof privateKeyToAccount>;

  beforeEach(async () => {
    const h = makeDb();
    db = h.db;
    const { id } = await enqueue(db, BASE_ENQ);
    queueId = id;
    signer = privateKeyToAccount(generatePrivateKey());
  });

  it('SECURITY: rejects legacy tx (type lock to EIP-1559)', async () => {
    const signedTx = await signLegacy(signer);
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'ConfigError' && /only EIP-1559/.test(e.message),
    );
  });

  it('SECURITY: rejects EIP-2930 tx (type lock)', async () => {
    const signedTx = await signEip2930(signer);
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('SECURITY: rejects non-empty accessList on EIP-1559', async () => {
    const signedTx = await signEip1559(signer, {
      accessList: [{ address: TO, storageKeys: [] }],
    });
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError && e.type === 'ConfigError' && /accessList/.test(e.message),
    );
  });

  it('SECURITY: rejects contract-creation tx (to=null) as ConfigError, not NotAuthorized', async () => {
    const signedTx = await signer.signTransaction({
      chainId: CHAIN_ID,
      // to omitted = contract creation
      value: 0n,
      data: '0x6080' as Hex,
      nonce: 0,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gas: 100_000n,
      type: 'eip1559',
    });
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        /contract-creation/.test(e.message),
    );
  });

  it('TOCTOU guard: non-pending row at probe time (status=signed) → ConfigError', async () => {
    await markSigned(db, {
      id: queueId,
      expectedUserId: USER_ID,
      signedTx: '0xabcd' as Hex,
      txHash: TX_HASH,
    });
    const signedTx = await signEip1559(signer);
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        e.type === 'ConfigError' &&
        /status 'signed'/.test(e.message),
    );
  });

  it('RPC OUTAGE during reconcile probe → pending-confirmation (fail-open, NOT failed)', async () => {
    const signedTx = await signEip1559(signer);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({
        receiptThrows: new Error('Timed out'),
        getTransactionResult: 'rpc-outage',
      }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('pending-confirmation');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('getTransaction probe failed'));
    warnSpy.mockRestore();
  });

  it('TransactionNotFoundError → markFailed (truly dropped)', async () => {
    const signedTx = await signEip1559(signer);
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({
        receiptThrows: new Error('Timed out'),
        getTransactionResult: 'not-found',
      }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('failed');
  });
});

describe('sanitize helpers — leak surface (post-merge round-2)', () => {
  it('redacts query-string apikey/key/token/secret', () => {
    const input = 'POST https://api.x/v2/rpc?apikey=FAKE_TEST_NOT_A_KEY&foo=ok';
    const out = sanitizeMessage(input);
    expect(out).not.toContain('FAKE_TEST_NOT_A_KEY');
    expect(out).toContain('<redacted>');
    expect(out).toContain('foo=ok');
  });

  it('redacts basic-auth user:pass@host URLs', () => {
    const input = 'connection failed: https://admin:FAKE_TEST_NOT_A_KEY@redis.internal/5';
    const out = sanitizeMessage(input);
    expect(out).not.toContain('FAKE_TEST_NOT_A_KEY');
    expect(out).not.toContain('admin:');
    expect(out).toContain('<redacted>@');
  });

  it('redacts path-segment keys (/v2/<key>, /v3/<key>, /rpc/<key>)', () => {
    const samples = [
      'https://eth-mainnet.g.alchemy.com/v2/FAKE_ALCHEMY_KEY_LONGENOUGH/blocknumber',
      'https://mainnet.infura.io/v3/FAKE_PROJECTID_LONGENOUGH_X',
      'https://api.pimlico.io/rpc/FAKE_PIMLICO_KEY_LONGENOUGH_X',
    ];
    for (const s of samples) {
      const out = sanitizeMessage(s);
      expect(out).not.toMatch(/FAKE_(ALCHEMY|PROJECTID|PIMLICO)/);
      expect(out).toContain('<redacted>');
    }
  });

  it('redacts Authorization Bearer + x-api-key header echoes', () => {
    const input =
      '401: Authorization: Bearer FAKE_BEARER_NOT_A_KEY received; x-api-key: FAKE_XKEY_NOT_A_KEY';
    const out = sanitizeMessage(input);
    expect(out).not.toContain('FAKE_BEARER_NOT_A_KEY');
    expect(out).not.toContain('FAKE_XKEY_NOT_A_KEY');
  });

  it('sanitizeError preserves cause + name', () => {
    class CustomViemError extends Error {
      override name = 'CustomViemError';
    }
    const inner = new CustomViemError('rpc 401 at https://x.io/rpc?apikey=FAKE_SECRET_LONGENOUGH');
    const wrapped = sanitizeError(inner);
    expect(wrapped.message).not.toContain('FAKE_SECRET_LONGENOUGH');
    expect(wrapped.message).toContain('<redacted>');
    expect(wrapped.cause).toBe(inner);
    expect(wrapped.name).toBe('CustomViemError');
  });

  it('does not eat tx hashes or addresses', () => {
    const input =
      '0x4444444444444444444444444444444444444444444444444444444444444444 reverted at 0x1234567890123456789012345678901234567890';
    const out = sanitizeMessage(input);
    expect(out).toBe(input);
  });
});
