// Read-only scope invariant for @concierge/ondo-usdy v1.
// This file is a deliberately brittle guard. If any future PR adds 'mint', 'redeem',
// 'transfer', 'burn', or 'approve' to the provider actions — bypassing USDY KYC — it
// will fail loudly here before reaching code review.
import { describe, expect, it } from 'vitest';
import { createOndoUsdyProvider } from '../provider.ts';

const MUTATION_ACTIONS = ['mint', 'redeem', 'transfer', 'burn', 'approve'] as const;

describe('OndoUsdyProvider — v1 read-only scope invariant', () => {
  const provider = createOndoUsdyProvider({ chain: 'mantle-mainnet' });

  it('provider.actions contains NO mutation actions (NoMutationActions guard)', () => {
    const actionKeys = Object.keys(provider.actions);
    for (const mutation of MUTATION_ACTIONS) {
      expect(actionKeys, `'${mutation}' must not exist in v1 read-only provider`).not.toContain(
        mutation,
      );
    }
  });

  it('provider.actions contains exactly the three expected read-only actions', () => {
    expect(Object.keys(provider.actions).sort()).toEqual([
      'getBalance',
      'getRateAccrual',
      'getYieldRate',
    ]);
  });
});
