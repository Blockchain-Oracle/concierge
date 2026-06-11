import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIFI_API } from '../../_context.ts';
import { executeGetStatus } from '../../actions/getStatus.ts';
import { DEST_TX_HASH, DEX_TX_HASH } from '../__mocks__/lifi-api.ts';
import { server } from '../setup.ts';

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const PENDING_TX = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const UNKNOWN_TX = '0x2222222222222222222222222222222222222222222222222222222222222222' as const;
const OPERATION_ID = 'route-stargate-001' as const;

const ctx = {
  chainId: 5000 as const,
  apiKey: undefined,
  publicClient: undefined,
  walletClient: undefined,
  integrator: 'concierge',
  lifiDiamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as const,
};

describe('getStatus — DONE (test_getStatus_Done)', () => {
  it('returns DONE with destinationTxHash and completedAttestation', async () => {
    const result = await executeGetStatus(ctx, {
      sourceTxHash: DEX_TX_HASH,
      lifiOperationId: OPERATION_ID,
      fromChain: 5000,
      toChain: 1,
    });

    expect(result.status).toBe('DONE');
    expect(result.destinationTxHash).toBe(DEST_TX_HASH);
    expect(result.bridgeUsed).toBe('stargate');
    expect(result.completedAttestation).not.toBeNull();
    expect(result.completedAttestation?.schema).toBe('concierge.lifi.bridge.completed.v1');
    expect(result.completedAttestation?.sourceTxHash).toBe(DEX_TX_HASH);
    expect(result.completedAttestation?.destinationTxHash).toBe(DEST_TX_HASH);
    expect(result.completedAttestation?.lifiOperationId).toBe(OPERATION_ID);
    expect(result.completedAttestation?.bridgeUsed).toBe('stargate');
  });
});

describe('getStatus — PENDING (test_getStatus_Pending)', () => {
  it('returns PENDING with null completedAttestation', async () => {
    const result = await executeGetStatus(ctx, {
      sourceTxHash: PENDING_TX,
      lifiOperationId: OPERATION_ID,
      fromChain: 5000,
      toChain: 1,
    });

    expect(result.status).toBe('PENDING');
    expect(result.destinationTxHash).toBeNull();
    expect(result.completedAttestation).toBeNull();
  });
});

describe('getStatus — NOT_FOUND (test_getStatus_NotFound)', () => {
  it('returns NOT_FOUND with null attestation for unknown tx', async () => {
    const result = await executeGetStatus(ctx, {
      sourceTxHash: UNKNOWN_TX,
      lifiOperationId: OPERATION_ID,
      fromChain: 5000,
      toChain: 1,
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(result.completedAttestation).toBeNull();
  });
});

describe('getStatus — FAILED (test_getStatus_Failed)', () => {
  it('returns FAILED with null completedAttestation when bridge fails on destination chain', async () => {
    server.use(
      http.get(`${LIFI_API}/status`, () =>
        HttpResponse.json({ status: 'FAILED', fromTx: { txHash: DEX_TX_HASH, chainId: 5000 } }),
      ),
    );
    const result = await executeGetStatus(ctx, {
      sourceTxHash: DEX_TX_HASH,
      lifiOperationId: OPERATION_ID,
      fromChain: 5000,
      toChain: 1,
    });

    expect(result.status).toBe('FAILED');
    expect(result.destinationTxHash).toBeNull();
    expect(result.completedAttestation).toBeNull();
  });
});

describe('getStatus — error paths', () => {
  it('throws ConciergeError(RpcError) on network failure', async () => {
    server.use(http.get(`${LIFI_API}/status`, () => HttpResponse.error()));
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(
      executeGetStatus(ctx, {
        sourceTxHash: DEX_TX_HASH,
        lifiOperationId: OPERATION_ID,
        fromChain: 5000,
        toChain: 1,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'RpcError',
    );
  });

  it('throws ConciergeError(RpcError) on HTTP 503', async () => {
    server.use(http.get(`${LIFI_API}/status`, () => new HttpResponse(null, { status: 503 })));
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(
      executeGetStatus(ctx, {
        sourceTxHash: DEX_TX_HASH,
        lifiOperationId: OPERATION_ID,
        fromChain: 5000,
        toChain: 1,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'RpcError',
    );
  });
});
