// Integration tests for getYieldRate — exercises the full fetch → parse → bps pipeline.
// Uses stubbed HTTP (not live Ethena API) for determinism; focuses on the tool invoke path.
import { ConciergeError } from '@concierge/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEthenaSusdeProvider } from '../../provider.ts';

const MOCK_ADDR = '0x1111111111111111111111111111111111111111' as const;

function makeProvider() {
  return createEthenaSusdeProvider({
    chain: 'mantle-mainnet',
    addresses: {
      usde: MOCK_ADDR,
      susde: MOCK_ADDR,
      usdc: MOCK_ADDR,
      aavePool: MOCK_ADDR,
      aaveOracle: MOCK_ADDR,
      woofiRouter: MOCK_ADDR,
    },
  });
}

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getYieldRate tool — nested API shape', () => {
  it('converts data.protocol + data.staking to bps via invoke()', async () => {
    stubFetch({ data: { protocol: 3.8, staking: 4.2 } });
    const result = await makeProvider().actions.getYieldRate.invoke({});
    expect(result.protocolYieldBps).toBe(380);
    expect(result.stakingYieldBps).toBe(420);
    expect(result.susdeYieldBps).toBe(420);
  });

  it('falls back to protocol when staking is absent', async () => {
    stubFetch({ data: { protocol: 5.0 } });
    const result = await makeProvider().actions.getYieldRate.invoke({});
    expect(result.susdeYieldBps).toBe(500);
  });
});

describe('getYieldRate tool — alternate API shapes', () => {
  it('handles flat (non-nested) protocol/staking fields', async () => {
    stubFetch({ protocol: 6.0, staking: 7.5 });
    const result = await makeProvider().actions.getYieldRate.invoke({});
    expect(result.susdeYieldBps).toBe(750);
  });

  it('handles snake_case protocol_yield / staking_yield', async () => {
    stubFetch({ data: { protocol_yield: 3.51, staking_yield: 3.8 } });
    const result = await makeProvider().actions.getYieldRate.invoke({});
    expect(result.protocolYieldBps).toBe(351);
    expect(result.stakingYieldBps).toBe(380);
  });
});

describe('getYieldRate tool — error paths', () => {
  it('throws RpcError when Ethena API returns non-200', async () => {
    stubFetch({}, 503);
    await expect(makeProvider().actions.getYieldRate.invoke({})).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});
