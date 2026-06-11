import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { createEthenaSusdeProvider } from '../../provider.ts';

describe('createEthenaSusdeProvider — unit', () => {
  it('exposes exactly 4 actions in sorted order', () => {
    const p = createEthenaSusdeProvider({ chain: 'mantle-mainnet' });
    expect(Object.keys(p.actions).sort()).toEqual([
      'getCarryVsAave',
      'getYieldRate',
      'unwrapToUSDe',
      'wrapToSusde',
    ]);
  });

  it('defaults to mantle-mainnet (chainId 5000) when no chain specified', () => {
    const p = createEthenaSusdeProvider();
    expect(p.chainId).toBe(5000);
  });

  it('resolves chainId 5003 for mantle-sepolia', () => {
    // Sepolia has ZERO_ADDRESS tokens — override addresses to skip the zero-guard.
    const mockAddr = '0x1111111111111111111111111111111111111111' as const;
    const p = createEthenaSusdeProvider({
      chain: 'mantle-sepolia',
      addresses: {
        usde: mockAddr,
        susde: mockAddr,
        usdc: mockAddr,
        aavePool: mockAddr,
        aaveOracle: mockAddr,
        woofiRouter: mockAddr,
      },
    });
    expect(p.chainId).toBe(5003);
  });

  it('throws ConfigError when a required address is zero (Sepolia without overrides)', () => {
    let caught: unknown;
    try {
      createEthenaSusdeProvider({ chain: 'mantle-sepolia' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConciergeError);
    expect((caught as ConciergeError).type).toBe('ConfigError');
  });

  it('throws NetworkUnsupported for unsupported chain via walletClient', () => {
    const fakeWallet = {
      chain: {
        id: 1,
        name: 'Ethereum',
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: ['https://rpc.mainnet.example'] } },
      },
    };
    let caught: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test-only fake WalletClient
      createEthenaSusdeProvider({ walletClient: fakeWallet as any });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConciergeError);
    expect((caught as ConciergeError).type).toBe('NetworkUnsupported');
  });
});
