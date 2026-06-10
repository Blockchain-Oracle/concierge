import { ADDRESSES, SEPOLIA_PENDING_ADDRESS_SLOTS } from '@concierge/shared';
import { type ConciergeAgentLike, createConciergeTools } from '@concierge/tools';
import { describe, expect, it } from 'vitest';
import { ConciergeError } from '../errors.ts';
import { ConciergeRegistry } from '../registry.ts';

describe('ConciergeRegistry bundled-address factories', () => {
  it('mainnet() targets chain 5000 with the FROZEN shared mainnet addresses (same reference)', () => {
    const registry = ConciergeRegistry.mainnet();
    expect(registry.chainId).toBe(5000);
    // Identity, not deep-equality: @concierge/shared is the one source of
    // truth for addresses; a copy could drift from it.
    expect(registry.addresses).toBe(ADDRESSES.mantleMainnet);
  });

  it('sepolia() targets chain 5003 with the shared sepolia addresses (same reference)', () => {
    const registry = ConciergeRegistry.sepolia();
    expect(registry.chainId).toBe(5003);
    expect(registry.addresses).toBe(ADDRESSES.mantleSepolia);
  });

  it('instances are frozen — addresses routing cannot be mutated at runtime', () => {
    const registry = ConciergeRegistry.mainnet();
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('satisfies ConciergeAgentLike, so it plugs straight into the tools registry', () => {
    const registry: ConciergeAgentLike = ConciergeRegistry.mainnet();
    expect(createConciergeTools(registry)).toEqual([]);
  });
});

describe('ConciergeRegistry.requireAddress (zero-address enforcement)', () => {
  it('returns the verified address for a populated mainnet slot', () => {
    expect(ConciergeRegistry.mainnet().requireAddress('aave.pool')).toBe(
      ADDRESSES.mantleMainnet.aave.pool,
    );
  });

  it('returns the real ERC-8004 address on sepolia (those slots ARE populated)', () => {
    expect(ConciergeRegistry.sepolia().requireAddress('erc8004.identityRegistry')).toBe(
      ADDRESSES.mantleSepolia.erc8004.identityRegistry,
    );
  });

  it('throws ConciergeError(NetworkUnsupported) for EVERY pending sepolia slot', () => {
    // Without this, a provider on chain 5003 would eth_call 0x0 and get an
    // opaque ABI-decode failure — or burn native value sent to 0x0 outright.
    const sepolia = ConciergeRegistry.sepolia();
    for (const slot of SEPOLIA_PENDING_ADDRESS_SLOTS) {
      let thrown: unknown;
      try {
        sepolia.requireAddress(slot);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected pending slot "${slot}" to throw`).toBeInstanceOf(ConciergeError);
      expect((thrown as ConciergeError).type).toBe('NetworkUnsupported');
      expect((thrown as ConciergeError).message).toContain(slot);
    }
  });

  it('mainnet has NO pending slots — every lockbox path resolves there', () => {
    const mainnet = ConciergeRegistry.mainnet();
    for (const slot of SEPOLIA_PENDING_ADDRESS_SLOTS) {
      expect(mainnet.requireAddress(slot)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});
