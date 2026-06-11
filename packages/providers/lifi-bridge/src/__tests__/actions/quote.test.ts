import { HttpResponse, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIFI_API } from '../../_context.ts';
import { executeQuote } from '../../actions/quote.ts';
import { FIXTURE_ROUTES } from '../__mocks__/lifi-api.ts';
import { server } from '../setup.ts';

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ctx = {
  chainId: 5000 as const,
  apiKey: undefined,
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

describe('quote — happy path (test_quote_HappyPath)', () => {
  it('returns 3 routes, bestRoute is first, estimatedDuration from fixture', async () => {
    const result = await executeQuote(ctx, BASE_INPUT);
    expect(result.routes.length).toBe(3);
    expect(result.bestRoute).not.toBeNull();
    expect(result.bestRoute?.id).toBe(FIXTURE_ROUTES[0]?.id);
    expect(result.estimatedDuration).toBe(600);
    expect(result.bridges.length).toBeGreaterThan(0);
  });

  it('all returned routes have transactionRequest (executable)', async () => {
    const result = await executeQuote(ctx, BASE_INPUT);
    for (const route of result.routes) {
      expect(route.transactionRequest).toBeDefined();
      expect(route.transactionRequest.to.toLowerCase()).toBe(
        '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
      );
    }
  });

  it('routes have _receivedAt timestamp for staleness tracking', async () => {
    const before = Date.now();
    const result = await executeQuote(ctx, BASE_INPUT);
    const after = Date.now();
    for (const route of result.routes) {
      expect(route._receivedAt).toBeGreaterThanOrEqual(before);
      expect(route._receivedAt).toBeLessThanOrEqual(after);
    }
  });
});

describe('quote — filtered bridges (test_quote_FilteredBridges)', () => {
  it('excludes routes using the specified bridge', async () => {
    const result = await executeQuote(ctx, { ...BASE_INPUT, excludeBridges: ['connext'] });
    for (const route of result.routes) {
      const tools = route.steps.map((s) => s.tool.toLowerCase());
      expect(tools).not.toContain('connext');
    }
    // 2 routes remain (stargate + across), connext filtered
    expect(result.routes.length).toBe(2);
  });

  it('excludeBridges removes all routes → routes: [], bestRoute: null', async () => {
    const result = await executeQuote(ctx, {
      ...BASE_INPUT,
      excludeBridges: ['stargate', 'across', 'connext'],
    });
    expect(result.routes).toEqual([]);
    expect(result.bestRoute).toBeNull();
    expect(result.estimatedDuration).toBe(0);
  });
});

describe('quote — no available routes (test_quote_NoRoute)', () => {
  it('returns routes: [], bestRoute: null when API returns empty', async () => {
    server.use(http.post(`${LIFI_API}/routes`, () => HttpResponse.json({ routes: [] })));
    const result = await executeQuote(ctx, BASE_INPUT);
    expect(result.routes).toEqual([]);
    expect(result.bestRoute).toBeNull();
  });
});

describe('quote — error paths', () => {
  it('throws ConciergeError(RpcError) on network failure', async () => {
    server.use(http.post(`${LIFI_API}/routes`, () => HttpResponse.error()));
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeQuote(ctx, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'RpcError',
    );
  });

  it('throws ConciergeError(RpcError) on HTTP 429', async () => {
    server.use(http.post(`${LIFI_API}/routes`, () => new HttpResponse(null, { status: 429 })));
    const { ConciergeError } = await import('@concierge/sdk');
    await expect(executeQuote(ctx, BASE_INPUT)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ConciergeError &&
        (e as InstanceType<typeof ConciergeError>).type === 'RpcError',
    );
  });
});
