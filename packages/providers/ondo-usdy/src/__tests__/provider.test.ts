// Integration tests for createOndoUsdyProvider — verifies the provider composes
// correctly and exposes the expected action surface and selector.
import { ADDRESSES } from '@concierge/shared';
import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOndoUsdyProvider } from '../provider.ts';
import { type AnvilFork, KNOWN_USDY_HOLDER, startAnvilFork } from './setup.ts';

const ADDRS = ADDRESSES.mantleMainnet;
const AGNI_USDY_USDC = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;
const USDY_BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;

describe('createOndoUsdyProvider — action surface', () => {
  it('exposes getBalance, getRateAccrual, getYieldRate — no mint or redeem', () => {
    const p = createOndoUsdyProvider({ chain: 'mantle-mainnet' });
    expect(Object.keys(p.actions).sort()).toEqual(['getBalance', 'getRateAccrual', 'getYieldRate']);
  });

  it('all actions support chainId 5000 but not 5003 via supportsNetwork()', () => {
    const p = createOndoUsdyProvider({ chain: 'mantle-mainnet' });
    for (const action of Object.values(p.actions)) {
      expect(action.supportsNetwork?.(5000)).toBe(true);
      expect(action.supportsNetwork?.(5003)).toBe(false);
    }
  });
});

describe('createOndoUsdyProvider — fork wiring', () => {
  let fork: AnvilFork;

  beforeAll(async () => {
    fork = await startAnvilFork();
  }, 60_000);

  afterAll(async () => {
    await fork.stop();
  });

  it('isUserEligible returns true for a non-blocked address (fork)', async () => {
    const provider = createOndoUsdyProvider({
      publicClient: createPublicClient({
        chain: fork.chain,
        transport: http(`http://127.0.0.1:${fork.port}`),
      }),
      chain: fork.chain,
      addresses: {
        usdy: ADDRS.tokens.USDY,
        agniUsdyUsdc: AGNI_USDY_USDC,
        usdyBlocklist: USDY_BLOCKLIST,
      },
    });
    // A regular holder should not be on the blocklist
    const eligible = await provider.selectors.isUserEligible(KNOWN_USDY_HOLDER);
    expect(eligible).toBe(true);
  }, 30_000);
});
