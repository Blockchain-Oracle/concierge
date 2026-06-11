/**
 * Verifies the two-stage attestation contract: sent.v1 (immediate) and
 * completed.v1 (after settlement) are linked by a shared lifiOperationId.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeBridge } from '../actions/bridge.ts';
import { executeGetStatus } from '../actions/getStatus.ts';
import { DEST_TX_HASH, DEX_TX_HASH } from './__mocks__/lifi-api.ts';
import { server } from './setup.ts';

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ctx = {
  chainId: 5000 as const,
  apiKey: undefined,
  integrator: 'concierge',
  lifiDiamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as const,
  walletClient: {
    account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` },
    sendTransaction: vi.fn().mockResolvedValue(DEX_TX_HASH),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock — WalletClient is a complex branded type
  } as any,
};

const BRIDGE_INPUT = {
  fromChain: 5000,
  toChain: 1,
  fromToken: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' as `0x${string}`,
  toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  amount: '100000000',
  slippageBps: 50,
  fromAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
};

describe('two-stage attestation — sent + completed (test_twoStage_AttestationLinkage)', () => {
  it('sent.v1 and completed.v1 share the same lifiOperationId', async () => {
    const bridgeResult = await executeBridge(ctx, BRIDGE_INPUT);
    const { lifiOperationId, sourceTxHash, attestationPayload: sentAttestation } = bridgeResult;

    const statusResult = await executeGetStatus(ctx, {
      sourceTxHash,
      lifiOperationId,
      fromChain: BRIDGE_INPUT.fromChain,
      toChain: BRIDGE_INPUT.toChain,
    });

    expect(statusResult.status).toBe('DONE');
    // biome-ignore lint/style/noNonNullAssertion: status is DONE, completedAttestation is guaranteed non-null
    const completedAttestation = statusResult.completedAttestation!;

    expect(sentAttestation.lifiOperationId).toBe(completedAttestation.lifiOperationId);
    expect(sentAttestation.sourceTxHash).toBe(completedAttestation.sourceTxHash);
    expect(completedAttestation.destinationTxHash).toBe(DEST_TX_HASH);
  });

  it('sent attestation has schema concierge.lifi.bridge.sent.v1', async () => {
    const { attestationPayload } = await executeBridge(ctx, BRIDGE_INPUT);
    expect(attestationPayload.schema).toBe('concierge.lifi.bridge.sent.v1');
  });

  it('completed attestation has schema concierge.lifi.bridge.completed.v1', async () => {
    const { sourceTxHash, lifiOperationId } = await executeBridge(ctx, BRIDGE_INPUT);
    const { completedAttestation } = await executeGetStatus(ctx, {
      sourceTxHash,
      lifiOperationId,
      fromChain: BRIDGE_INPUT.fromChain,
      toChain: BRIDGE_INPUT.toChain,
    });
    expect(completedAttestation?.schema).toBe('concierge.lifi.bridge.completed.v1');
  });

  it('both attestations carry consistent chain IDs', async () => {
    const {
      lifiOperationId,
      sourceTxHash,
      attestationPayload: sentAttestation,
    } = await executeBridge(ctx, BRIDGE_INPUT);
    const { completedAttestation } = await executeGetStatus(ctx, {
      sourceTxHash,
      lifiOperationId,
      fromChain: BRIDGE_INPUT.fromChain,
      toChain: BRIDGE_INPUT.toChain,
    });

    expect(sentAttestation.fromChain).toBe(5000);
    expect(sentAttestation.toChain).toBe(1);
    expect(completedAttestation?.fromChain).toBe(5000);
    expect(completedAttestation?.toChain).toBe(1);
  });

  it('sent attestation ts is a unix epoch in seconds, not milliseconds', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { attestationPayload } = await executeBridge(ctx, BRIDGE_INPUT);
    const after = Math.floor(Date.now() / 1000);

    // Unix epoch seconds are ~1.7e9; milliseconds would be ~1.7e12 (3 orders of magnitude larger)
    expect(attestationPayload.ts).toBeGreaterThanOrEqual(before);
    expect(attestationPayload.ts).toBeLessThanOrEqual(after + 1);
    // Guard against accidental Date.now() (ms) instead of Math.floor(Date.now()/1000)
    expect(attestationPayload.ts).toBeLessThan(2_000_000_000);
  });
});
