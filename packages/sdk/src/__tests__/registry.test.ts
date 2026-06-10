import { ADDRESSES, type AddressPath, SEPOLIA_PENDING_ADDRESS_SLOTS } from '@concierge/shared';
import { type ConciergeAgentLike, createConciergeTools } from '@concierge/tools';
import { describe, expect, it } from 'vitest';
import { ConciergeError } from '../errors.ts';
import { ConciergeRegistry } from '../registry.ts';

/** Simulates a plain-JS caller — the compile-time path union doesn't protect them. */
const asPath = (s: string) => s as AddressPath;

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
      expect((thrown as ConciergeError).message, 'error must self-locate its chain').toContain(
        '5003',
      );
    }
  });

  it('mainnet has NO pending slots — every lockbox path resolves there', () => {
    const mainnet = ConciergeRegistry.mainnet();
    for (const slot of SEPOLIA_PENDING_ADDRESS_SLOTS) {
      expect(mainnet.requireAddress(slot)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('throws TypeError (NOT NetworkUnsupported) for an unknown path — a typo is caller misuse', () => {
    // A JS caller typo must not be misdiagnosed as a network problem: a
    // `switch (err.type)` handler would chase a network issue that doesn't exist.
    const mainnet = ConciergeRegistry.mainnet();
    expect(() => mainnet.requireAddress(asPath('aave.poool'))).toThrow(TypeError);
    expect(() => mainnet.requireAddress(asPath('aave.poool'))).toThrow(/aave\.poool/);
    expect(() => mainnet.requireAddress(asPath('aave.poool'))).toThrow(/\[@concierge\/sdk\]/);
    expect(() => mainnet.requireAddress(asPath('aave.poool'))).toThrow(/chain 5000/);
    expect(() => mainnet.requireAddress(asPath('aave'))).toThrow(TypeError); // branch node, not a leaf
  });

  it('closes the string-index hole — a trailing segment indexes INTO the address string', () => {
    // '0x000…000'['0'] === '0': typeof '0' is 'string' and '0' !== ZERO, so a
    // shape-unaware guard would RETURN '0' for a pending Sepolia slot — the
    // exact failure requireAddress exists to block.
    expect(() => ConciergeRegistry.sepolia().requireAddress(asPath('tokens.USDC.0'))).toThrow(
      TypeError,
    );
    expect(() => ConciergeRegistry.mainnet().requireAddress(asPath('aave.pool.0'))).toThrow(
      TypeError,
    );
  });

  it('prototype-chain walks are fail-closed', () => {
    expect(() => ConciergeRegistry.mainnet().requireAddress(asPath('__proto__.x'))).toThrow(
      TypeError,
    );
  });
});
