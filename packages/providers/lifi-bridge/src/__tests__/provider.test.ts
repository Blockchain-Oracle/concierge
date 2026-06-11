import { describe, expect, it } from 'vitest';
import { LIFI_DIAMOND } from '../_context.ts';
import { createLifiBridgeProvider } from '../provider.ts';

describe('createLifiBridgeProvider — action surface', () => {
  it("exposes exactly ['bridge','getStatus','quote']", () => {
    const p = createLifiBridgeProvider();
    expect(Object.keys(p.actions).sort()).toEqual(['bridge', 'getStatus', 'quote']);
  });

  it('chainId is always 5000 (Mantle Mainnet)', () => {
    const p = createLifiBridgeProvider();
    expect(p.chainId).toBe(5000);
  });

  it('all actions have supportsNetwork returning true (multi-chain by design)', () => {
    const p = createLifiBridgeProvider();
    for (const action of Object.values(p.actions)) {
      expect(action.supportsNetwork?.(5000)).toBe(true);
      // Li.Fi tools accept any Mantle chain (mainnet + Sepolia)
      expect(action.supportsNetwork?.(5003)).toBe(true);
    }
  });

  it('provider is frozen (immutable object)', () => {
    const p = createLifiBridgeProvider();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.actions)).toBe(true);
  });
});

describe('createLifiBridgeProvider — Diamond address', () => {
  it('LIFI_DIAMOND matches the verified on-chain address (2026-06-04)', () => {
    expect(LIFI_DIAMOND).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');
  });
});
