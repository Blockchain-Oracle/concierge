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
import { enqueue } from '../queue.ts';
import { sendSignedTx } from '../sender.ts';
import {
  BASE_ENQ,
  CHAIN_ID,
  DATA,
  makeDb,
  OTHER_USER,
  TO,
  TX_HASH,
  USER_ID,
  VALUE,
} from './_eoaStub.ts';

async function signTx(
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

function makePublicClient(opts: {
  sendThrows?: Error;
  receiptStatus?: 'success' | 'reverted';
  receiptThrows?: Error;
  getTransactionReturns?: 'found' | 'notfound';
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
      if (opts.getTransactionReturns === 'notfound') {
        throw new TransactionNotFoundError({ hash: TX_HASH });
      }
      return { hash: TX_HASH };
    }),
  };
  return stub as PublicClient;
}

describe('sendSignedTx — payload binding + lifecycle (story-55 security)', () => {
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

  it('happy path: parse → bind → broadcast → confirm', async () => {
    const signedTx = await signTx(signer);
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({ receiptStatus: 'success' }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('confirmed');
    if (result.kind === 'confirmed') {
      expect(result.row.status).toBe('confirmed');
      expect(result.row.blockNumber).toBe(9999n);
    }
  });

  it('SECURITY: rejects mismatched `to` (payload substitution)', async () => {
    const signedTx = await signTx(signer, {
      to: '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0' as Address,
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
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'NotAuthorized');
  });

  it('SECURITY: rejects mismatched `data`', async () => {
    const signedTx = await signTx(signer, { data: '0xcafebabe' as Hex });
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
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'NotAuthorized');
  });

  it('SECURITY: rejects mismatched `value`', async () => {
    const signedTx = await signTx(signer, { value: 1n });
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
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'NotAuthorized');
  });

  it('SECURITY: rejects mismatched chainId', async () => {
    const signedTx = await signTx(signer, { chainId: 1 });
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
      (e: unknown) => e instanceof ConciergeError && e.type === 'NetworkUnsupported',
    );
  });

  it('SECURITY: rejects when signer != expectedSigner', async () => {
    const wrongSigner = privateKeyToAccount(generatePrivateKey());
    const signedTx = await signTx(signer);
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: wrongSigner.address,
        signedTx,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvalidOwnerSignature',
    );
  });

  it('SECURITY: cross-tenant queueId rejected as NotAuthorized (no info leak)', async () => {
    const signedTx = await signTx(signer);
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: OTHER_USER,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'NotAuthorized');
  });

  it('on-chain revert → markFailed; error is ConciergeError', async () => {
    const signedTx = await signTx(signer);
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({ receiptStatus: 'reverted' }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBeInstanceOf(ConciergeError);
      expect(result.error.message).toMatch(/reverted/);
    }
  });

  it('pre-broadcast viem error → markFailed; row never reaches signed; Pimlico key redacted', async () => {
    const signedTx = await signTx(signer);
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({
        sendThrows: new Error(
          'Pimlico 401 https://api.pimlico.io/v2/mantle/rpc?apikey=FAKE_TEST_FIXTURE_NOT_A_KEY',
        ),
      }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.row.signedTx).toBeNull();
      expect(result.error.message).toContain('<redacted>');
      expect(result.error.message).not.toContain('FAKE_TEST_FIXTURE_NOT_A_KEY');
    }
  });

  it('receipt timeout + mempool hit → pending-confirmation (does NOT markFailed)', async () => {
    const signedTx = await signTx(signer);
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({
        receiptThrows: new Error('Timed out waiting for receipt'),
        getTransactionReturns: 'found',
      }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('pending-confirmation');
    if (result.kind === 'pending-confirmation') {
      expect(result.txHash).toBe(TX_HASH);
      expect(result.row.status).toBe('signed');
    }
  });

  it('receipt timeout + mempool miss → markFailed (truly dropped)', async () => {
    const signedTx = await signTx(signer);
    const result = await sendSignedTx({
      db,
      publicClient: makePublicClient({
        receiptThrows: new Error('Timed out waiting for receipt'),
        getTransactionReturns: 'notfound',
      }),
      queueId,
      expectedUserId: USER_ID,
      expectedChainId: CHAIN_ID,
      expectedSigner: signer.address,
      signedTx,
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects invalid signedTx hex (byte-alignment + length cap)', async () => {
    await expect(
      sendSignedTx({
        db,
        publicClient: makePublicClient({}),
        queueId,
        expectedUserId: USER_ID,
        expectedChainId: CHAIN_ID,
        expectedSigner: signer.address,
        signedTx: 'not-hex' as Hex,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });
});
