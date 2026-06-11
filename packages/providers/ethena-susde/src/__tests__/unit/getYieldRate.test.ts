import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeGetYieldRate } from '../../actions/getYieldRate.ts';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

function makeCtx(): ActionContext {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock for read-only actions
    publicClient: {} as any,
    chainId: 5000,
    addresses: {
      usde: ZERO,
      susde: ZERO,
      usdc: ZERO,
      aavePool: ZERO,
      aaveOracle: ZERO,
      woofiRouter: ZERO,
    },
  };
}

function makeApiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string | URL) => handler(String(url)));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('executeGetYieldRate — success paths', () => {
  it('converts nested data.protocol + data.staking percentages to bps', async () => {
    stubFetch(() => makeApiResponse({ data: { protocol: 3.8, staking: 4.2 } }));
    const r = await executeGetYieldRate(makeCtx());
    expect(r.protocolYieldBps).toBe(380);
    expect(r.stakingYieldBps).toBe(420);
    expect(r.susdeYieldBps).toBe(420);
  });

  it('falls back to protocol yield when staking is missing', async () => {
    stubFetch(() => makeApiResponse({ data: { protocol: 5.0 } }));
    const r = await executeGetYieldRate(makeCtx());
    expect(r.protocolYieldBps).toBe(500);
    expect(r.susdeYieldBps).toBe(500);
  });

  it('handles flat (non-nested) response shape', async () => {
    stubFetch(() => makeApiResponse({ protocol: 6.0, staking: 7.5 }));
    const r = await executeGetYieldRate(makeCtx());
    expect(r.susdeYieldBps).toBe(750);
  });

  it('handles snake_case protocol_yield / staking_yield field names', async () => {
    stubFetch(() => makeApiResponse({ data: { protocol_yield: 3.51, staking_yield: 3.8 } }));
    const r = await executeGetYieldRate(makeCtx());
    expect(r.protocolYieldBps).toBe(351);
    expect(r.stakingYieldBps).toBe(380);
  });
});

describe('executeGetYieldRate — error paths', () => {
  it('throws RpcError on non-200 response', async () => {
    stubFetch(() => makeApiResponse({}, 503));
    await expect(executeGetYieldRate(makeCtx())).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when parsed yield is zero', async () => {
    stubFetch(() => makeApiResponse({}));
    await expect(executeGetYieldRate(makeCtx())).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });

  it('throws RpcError when fetch rejects', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });
    await expect(executeGetYieldRate(makeCtx())).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});
