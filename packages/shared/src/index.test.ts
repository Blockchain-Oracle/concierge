// Sanity tests for @concierge/shared. Every address must be a valid
// 0x-prefixed 40-hex string OR the zero-address placeholder (Sepolia
// mock-deploy slots filled by story-190+). Plus the spec's hard-pinned
// addresses (Aave Pool / Li.Fi Diamond / ERC-8004) match research/.

import { describe, expect, it } from 'vitest';
import { ADDRESSES, addressesFor, chainFor, mantleMainnet, mantleSepolia } from './index.ts';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

function flattenAddresses(
  obj: unknown,
  path: string[] = [],
): Array<{ path: string; value: string }> {
  if (typeof obj === 'string') return [{ path: path.join('.'), value: obj }];
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).flatMap(([k, v]) => flattenAddresses(v, [...path, k]));
  }
  return [];
}

describe('ADDRESSES shape', () => {
  it('every entry matches 0x[40-hex] format', () => {
    const all = flattenAddresses(ADDRESSES);
    expect(all.length).toBeGreaterThan(20);
    for (const { path, value } of all) {
      expect(value, `${path} must match 0x[40-hex]`).toMatch(ADDRESS_RE);
    }
  });

  it('Mantle Mainnet has no zero-address placeholders for live contracts', () => {
    // Spec contract: every Mainnet address is real (verified 2026-06-03).
    const live = flattenAddresses(ADDRESSES.mantleMainnet);
    for (const { path, value } of live) {
      expect(value, `mantleMainnet.${path} must not be the zero address`).not.toBe(ZERO);
    }
  });

  it('Mantle Sepolia ERC-8004 addresses are populated (real testnet deployment)', () => {
    expect(ADDRESSES.mantleSepolia.erc8004.identityRegistry).not.toBe(ZERO);
    expect(ADDRESSES.mantleSepolia.erc8004.reputationRegistry).not.toBe(ZERO);
  });
});

describe('ADDRESSES Mainnet pinned values', () => {
  it('ERC-8004 identity registry matches research/concierge/03-providers/erc8004.md', () => {
    expect(ADDRESSES.mantleMainnet.erc8004.identityRegistry).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
  });

  it('ERC-8004 reputation registry matches research/', () => {
    expect(ADDRESSES.mantleMainnet.erc8004.reputationRegistry).toBe(
      '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    );
  });

  it('Aave V3 Mantle Pool matches aave-address-book + cast call POOL', () => {
    expect(ADDRESSES.mantleMainnet.aave.pool).toBe('0x458F293454fE0d67EC0655f3672301301DD51422');
  });

  it('Aave Oracle matches provider.getPriceOracle()', () => {
    expect(ADDRESSES.mantleMainnet.aave.oracle).toBe('0x47a063CfDa980532267970d478EC340C0F80E8df');
  });

  it('Li.Fi Diamond matches /v1/chains API + cross-chain canonical', () => {
    expect(ADDRESSES.mantleMainnet.lifi.diamond).toBe('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');
  });

  it('Merchant Moe LB Router (v2.2) matches lbRouter.getFactory() round-trip', () => {
    expect(ADDRESSES.mantleMainnet.mantleDex.merchantMoe.lbRouter).toBe(
      '0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a',
    );
  });

  it('Agni Factory matches SwapRouter.factory() round-trip', () => {
    expect(ADDRESSES.mantleMainnet.mantleDex.agni.factory).toBe(
      '0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035',
    );
  });
});

describe('helpers', () => {
  it('addressesFor(5000) returns Mainnet block', () => {
    expect(addressesFor(5000)).toBe(ADDRESSES.mantleMainnet);
  });

  it('addressesFor(5003) returns Sepolia block', () => {
    expect(addressesFor(5003)).toBe(ADDRESSES.mantleSepolia);
  });

  it('chainFor(5000) returns viem mantle mainnet config', () => {
    expect(chainFor(5000)).toBe(mantleMainnet);
    expect(chainFor(5000).id).toBe(5000);
  });

  it('chainFor(5003) returns Mantle Sepolia config (testnet=true)', () => {
    expect(chainFor(5003)).toBe(mantleSepolia);
    expect(chainFor(5003).id).toBe(5003);
    expect(chainFor(5003).testnet).toBe(true);
  });
});
