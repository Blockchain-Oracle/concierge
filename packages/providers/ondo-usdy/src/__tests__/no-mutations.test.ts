// Read-only scope invariant for @concierge/ondo-usdy v1.
// This file is a deliberately brittle guard. If any future PR adds 'mint', 'redeem',
// 'transfer', 'burn', or 'approve' to the provider actions — bypassing USDY KYC — it
// will fail loudly here before reaching code review.
import { beforeAll, describe, expect, it } from 'vitest';
import { createOndoUsdyProvider } from '../provider.ts';

const MUTATION_ACTIONS = ['mint', 'redeem', 'transfer', 'burn', 'approve'] as const;

describe('OndoUsdyProvider — v1 read-only scope invariant', () => {
  let provider: ReturnType<typeof createOndoUsdyProvider>;

  beforeAll(() => {
    provider = createOndoUsdyProvider({ chain: 'mantle-mainnet' });
  });

  it('provider.actions contains ONLY the three expected read-only actions (NoMutationActions guard)', () => {
    // Whitelist is the primary guard: any new key (mutating or otherwise) fails here.
    expect(Object.keys(provider.actions).sort()).toEqual([
      'getBalance',
      'getRateAccrual',
      'getYieldRate',
    ]);
    // Explicit blacklist documents what is forbidden even if the whitelist is ever loosened.
    const actionKeys = Object.keys(provider.actions);
    for (const mutation of MUTATION_ACTIONS) {
      expect(actionKeys, `'${mutation}' must not exist in v1 read-only provider`).not.toContain(
        mutation,
      );
    }
  });
});
