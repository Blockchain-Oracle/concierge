import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIFI_API } from '../../_context.ts';
import type { LifiBridgeRoute } from '../../_types.ts';
import { executeBridge } from '../../actions/bridge.ts';
import { FIXTURE_ROUTES } from '../__mocks__/lifi-api.ts';
import { server } from '../setup.ts';

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SOURCE_TX = '0xaaaa000000000000000000000000000000000000000000000000000000000001' as const;

function makeWalletClient(txHash: `0x${string}` = SOURCE_TX) {
  return {
    account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` },
    chain: { id: 5000 }, // must match route transactionRequest.chainId (fail-closed chain guard)
    sendTransaction: vi.fn().mockResolvedValue(txHash),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock object — WalletClient is a complex branded type
  } as any;
}

const BASE_CTX = {
  chainId: 5000 as const,
  apiKey: undefined,
  publicClient: undefined,
  integrator: 'concierge',
  lifiDiamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as const,
};

const BASE_INPUT = {
  fromChain: 5000,
  toChain: 1,
  fromToken: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' as `0x${string}`,
  toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  amount: '100000000',
  slippageBps: 50,
  fromAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
};

describe('bridge — happy path (test_bridge_SubmitsAndReturnsSentAttestation)', () => {
  it('submits tx and returns sourceTxHash + attestation with LIFI_SENT_SCHEMA', async () => {
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };

    const result = await executeBridge(ctx, BASE_INPUT);

    expect(result.sourceTxHash).toBe(SOURCE_TX);
    expect(result.lifiOperationId).toBe(FIXTURE_ROUTES[0]?.id);
    expect(result.expectedDuration).toBe(600);
    expect(result.attestationPayload.schema).toBe('concierge.lifi.bridge.sent.v1');
    expect(result.attestationPayload.sourceTxHash).toBe(SOURCE_TX);
    expect(result.attestationPayload.fromChain).toBe(5000);
    expect(result.attestationPayload.toChain).toBe(1);
  });

  it('walletClient.sendTransaction is called with transactionRequest fields', async () => {
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };

    await executeBridge(ctx, BASE_INPUT);

    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
    const call = walletClient.sendTransaction.mock.calls[0][0];
    expect(call.to.toLowerCase()).toBe('0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae');
    expect(call.data).toMatch(/^0x/);
    expect(typeof call.value).toBe('bigint');
  });

  it('uses provided fresh route without re-quoting', async () => {
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };
    // biome-ignore lint/style/noNonNullAssertion: fixture always has 2 routes
    const freshRoute: LifiBridgeRoute = { ...FIXTURE_ROUTES[1]!, _receivedAt: Date.now() };

    let quoteCallCount = 0;
    server.use(
      http.get(`${LIFI_API}/quote`, () => {
        quoteCallCount++;
        return new HttpResponse(null, { status: 500 }); // Should never be reached
      }),
    );

    const result = await executeBridge(ctx, { ...BASE_INPUT, route: freshRoute });
    expect(quoteCallCount).toBe(0);
    expect(result.lifiOperationId).toBe(freshRoute.id);
  });
});

describe('bridge — stale route triggers re-quote (test_bridge_StaleRouteReQuotes)', () => {
  it('re-quotes when route _receivedAt is beyond the 30s TTL', async () => {
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };
    // biome-ignore lint/style/noNonNullAssertion: fixture always has 2 routes
    const staleRoute: LifiBridgeRoute = { ...FIXTURE_ROUTES[0]!, _receivedAt: Date.now() - 40_000 };

    const result = await executeBridge(ctx, { ...BASE_INPUT, route: staleRoute });

    expect(result.sourceTxHash).toBe(SOURCE_TX);
    expect(result.attestationPayload.schema).toBe('concierge.lifi.bridge.sent.v1');
  });

  it('stale route re-quote uses fresh route id as lifiOperationId, not stale route id', async () => {
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };
    const staleRoute: LifiBridgeRoute = {
      // biome-ignore lint/style/noNonNullAssertion: fixture always has 2 routes
      ...FIXTURE_ROUTES[0]!,
      id: 'stale-route-id-will-not-appear-in-attestation',
      _receivedAt: Date.now() - 40_000,
    };

    const result = await executeBridge(ctx, { ...BASE_INPUT, route: staleRoute });

    // Fresh quote from re-quote is FIXTURE_ROUTES[0] (stargate) — id = 'route-stargate-001'
    expect(result.lifiOperationId).toBe(FIXTURE_ROUTES[0]?.id);
    expect(result.lifiOperationId).not.toBe('stale-route-id-will-not-appear-in-attestation');
    expect(result.attestationPayload.lifiOperationId).toBe(result.lifiOperationId);
  });
});

describe('bridge — wallet error paths', () => {
  it('throws ConciergeError(ConfigError) when walletClient is absent', async () => {
    const ctx = { ...BASE_CTX };
    const { ConciergeError } = await import('@concierge/sdk');
    // biome-ignore lint/suspicious/noExplicitAny: intentionally passing incomplete ctx to test missing-walletClient guard
    await expect(executeBridge(ctx as any, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'ConfigError',
    );
  });

  it('throws ConciergeError(ConfigError) when walletClient has no bound account', async () => {
    const walletClient = {
      account: undefined,
      sendTransaction: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: testing the no-account guard path
    } as any;
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'ConfigError',
    );
  });

  it('throws ConciergeError(RpcError) when sendTransaction fails', async () => {
    const walletClient = {
      account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` },
      chain: { id: 5000 },
      sendTransaction: vi.fn().mockRejectedValue(new Error('user rejected')),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock — WalletClient is a complex branded type
    } as any;
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'RpcError',
    );
  });
});

describe('bridge — API error paths', () => {
  it('throws ConciergeError(RpcError) when API returns 503 during re-quote', async () => {
    server.use(http.get(`${LIFI_API}/quote`, () => new HttpResponse(null, { status: 503 })));
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'RpcError',
    );
  });

  it('throws ConciergeError(InsufficientLiquidity) when API returns 422 (no route)', async () => {
    server.use(http.get(`${LIFI_API}/quote`, () => new HttpResponse(null, { status: 422 })));
    const walletClient = makeWalletClient();
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'InsufficientLiquidity',
    );
  });
});

describe('bridge — chain guard (test_bridge_ChainGuard)', () => {
  it('throws ConciergeError(ConfigError) when walletClient has no bound chain', async () => {
    const walletClient = {
      account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` },
      // no chain — fail-closed guard requires bound chain before submission
      sendTransaction: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: testing no-chain guard path
    } as any;
    // biome-ignore lint/style/noNonNullAssertion: fixture always has at least 1 route
    const freshRoute: LifiBridgeRoute = { ...FIXTURE_ROUTES[0]!, _receivedAt: Date.now() };
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, { ...BASE_INPUT, route: freshRoute })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'ConfigError',
    );
  });

  it('throws ConciergeError(NetworkUnsupported) when wallet chain does not match route chain', async () => {
    const walletClient = {
      account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` },
      chain: { id: 1 }, // Ethereum mainnet, but route is on Mantle (5000)
      sendTransaction: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: testing chain mismatch guard
    } as any;
    // biome-ignore lint/style/noNonNullAssertion: fixture always has 2 routes
    const freshRoute: LifiBridgeRoute = { ...FIXTURE_ROUTES[0]!, _receivedAt: Date.now() };
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, { ...BASE_INPUT, route: freshRoute })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'NetworkUnsupported',
    );
  });

  it('throws ConciergeError(ConfigError) when route targets a non-LIFI_DIAMOND address', async () => {
    const walletClient = makeWalletClient();
    const maliciousRoute: LifiBridgeRoute = {
      // biome-ignore lint/style/noNonNullAssertion: fixture always has at least 1 route
      ...FIXTURE_ROUTES[0]!,
      _receivedAt: Date.now(),
      transactionRequest: {
        // biome-ignore lint/style/noNonNullAssertion: fixture always has at least 1 route
        ...FIXTURE_ROUTES[0]!.transactionRequest,
        to: '0xDeAdDeAdDeAdDeAdDeAdDeAdDeAdDeAdDeAdDeAd',
      },
    };
    const ctx = { ...BASE_CTX, walletClient };
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeBridge(ctx, { ...BASE_INPUT, route: maliciousRoute })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'ConfigError',
    );
  });
});
