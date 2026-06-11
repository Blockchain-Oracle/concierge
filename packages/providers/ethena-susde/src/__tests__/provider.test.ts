// Integration tests for createEthenaSusdeProvider — verifies the provider composes
// correctly and exposes the expected action surface for callers.
import { ADDRESSES } from '@concierge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEthenaSusdeProvider } from '../provider.ts';
import { stubEthenaApi } from './setup.ts';

const ADDRS = ADDRESSES.mantleMainnet;

function makeProvider() {
  return createEthenaSusdeProvider({
    chain: 'mantle-mainnet',
    addresses: {
      usde: ADDRS.tokens.USDe,
      susde: ADDRS.tokens.sUSDe,
      usdc: ADDRS.tokens.USDC,
      aavePool: ADDRS.aave.pool,
      aaveOracle: ADDRS.aave.oracle,
      woofiRouter: ADDRS.mantleDex.woofi.router,
    },
  });
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createEthenaSusdeProvider — action surface', () => {
  it('exposes getYieldRate, getCarryVsAave, wrapToSusde, unwrapToUSDe', () => {
    const p = makeProvider();
    expect(Object.keys(p.actions).sort()).toEqual([
      'getCarryVsAave',
      'getYieldRate',
      'unwrapToUSDe',
      'wrapToSusde',
    ]);
  });

  it('all actions support chainId 5000 but not 5003 via supportsNetwork()', () => {
    const p = makeProvider();
    for (const action of Object.values(p.actions)) {
      expect(action.supportsNetwork?.(5000)).toBe(true);
      expect(action.supportsNetwork?.(5003)).toBe(false);
    }
  });
});

describe('createEthenaSusdeProvider — getCarryVsAave wiring', () => {
  it('getCarryVsAave is wired through to Aave pool + Ethena API and returns carry result', async () => {
    stubEthenaApi(3.8); // 380 bps
    const result = await makeProvider().actions.getCarryVsAave.invoke({ spreadFloor: 0 });
    // Verifies: Ethena stub → 380 bps, Aave pool (real mainnet RPC) → numeric borrow bps.
    expect(result.susdeYieldBps).toBe(380);
    expect(result.usdcBorrowBps).toBeGreaterThan(0);
    expect(result.carryBps).toBe(380 - result.usdcBorrowBps);
    expect(typeof result.spreadFloorPassing).toBe('boolean');
  });
});
