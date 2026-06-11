import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { createOndoUsdyProvider } from '../../provider.ts';

describe('createOndoUsdyProvider — action surface', () => {
  it('exposes exactly getBalance, getRateAccrual, getYieldRate — no mint or redeem', () => {
    const p = createOndoUsdyProvider({ chain: 'mantle-mainnet' });
    expect(Object.keys(p.actions).sort()).toEqual(['getBalance', 'getRateAccrual', 'getYieldRate']);
    expect('mint' in p.actions).toBe(false);
    expect('redeem' in p.actions).toBe(false);
  });

  it('all actions support chainId 5000 via supportsNetwork()', () => {
    const p = createOndoUsdyProvider({ chain: 'mantle-mainnet' });
    for (const action of Object.values(p.actions)) {
      expect(action.supportsNetwork?.(5000)).toBe(true);
      expect(action.supportsNetwork?.(5003)).toBe(false);
      // biome-ignore lint/suspicious/noExplicitAny: testing non-Mantle chainId
      expect(action.supportsNetwork?.(1 as any)).toBe(false);
    }
  });

  it('exposes isUserEligible selector', () => {
    const p = createOndoUsdyProvider({ chain: 'mantle-mainnet' });
    expect(typeof p.selectors.isUserEligible).toBe('function');
  });

  it('throws NetworkUnsupported for non-Mantle chain', () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid chainId input
    const ethereumMainnet = {
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://eth.llamarpc.com'] } },
    } as any;
    let thrown: unknown;
    try {
      createOndoUsdyProvider({ chain: ethereumMainnet });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown instanceof ConciergeError && (thrown as ConciergeError).type === 'NetworkUnsupported',
    ).toBe(true);
  });
});
