// Sanity + invariant tests for @concierge/shared.
//
// Coverage targets the reviewer fleet's CRITICAL/IMPORTANT/SUGGESTION findings on PR #12:
//  - every Mainnet address pinned against research/concierge/ (typo would slip the regex)
//  - every Sepolia "pending" slot tracked in a lockbox so story-192 can't silently regress
//  - helpers throw on unknown chain ids (defense-in-depth, currently dead code at type level)
//  - ADDRESSES is deeply frozen at runtime so a downstream package can't mutate the registry
//  - branded AgentId has a runtime constructor + guard
//  - public type unions match exact arity (catches accidental widening to `string`)
//  - EIP-55 checksum on every Mainnet entry except the canonical WETH vanity sentinel

import { getAddress } from 'viem';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ActionKind,
  ADDRESSES,
  type Address,
  type AgentId,
  addressesFor,
  agentId,
  chainFor,
  type EvmChainId,
  isAgentId,
  mantleMainnet,
  mantleSepolia,
  type ProviderName,
  SEPOLIA_PENDING_ADDRESS_SLOTS,
  type TickPhase,
} from './index.ts';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

// Canonical Mantle WETH vanity address per research/concierge/03-providers/aave-v3-mantle.md:34.
// Vanity addresses do not satisfy EIP-55 mixed-case checksum — exempt from getAddress() equality.
const WETH_VANITY = '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111';

function flattenAddresses(
  obj: unknown,
  path: string[] = [],
): Array<{ path: string; value: string }> {
  if (typeof obj === 'string') return [{ path: path.join('.'), value: obj }];
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).flatMap(([k, v]) => flattenAddresses(v, [...path, k]));
  }
  // Reviewer finding: silently dropping unexpected leaf types lets a future bug (a number /
  // null / boolean accidentally landing in ADDRESSES) pass the shape test. Fail loudly.
  throw new Error(`flattenAddresses: unexpected leaf at ${path.join('.')} (${typeof obj})`);
}

describe('ADDRESSES shape', () => {
  it('every entry matches 0x[40-hex] format', () => {
    const all = flattenAddresses(ADDRESSES);
    for (const { path, value } of all) {
      expect(value, `${path} must match 0x[40-hex]`).toMatch(ADDRESS_RE);
    }
  });

  it('has the expected 32-leaf shape (bump this when adding addresses)', () => {
    // 4 aave + 7 tokens + 2 erc8004 + 1 lifi + 2 dex = 16 per network × 2 networks = 32.
    expect(flattenAddresses(ADDRESSES)).toHaveLength(32);
  });

  it('Mantle Mainnet has no zero-address placeholders for live contracts', () => {
    const live = flattenAddresses(ADDRESSES.mantleMainnet);
    for (const { path, value } of live) {
      expect(value, `mantleMainnet.${path} must not be the zero address`).not.toBe(ZERO);
    }
  });

  it('Mantle Mainnet addresses satisfy EIP-55 checksum (except canonical WETH vanity)', () => {
    const live = flattenAddresses(ADDRESSES.mantleMainnet);
    for (const { path, value } of live) {
      if (value === WETH_VANITY) continue;
      const checksummed = getAddress(value);
      expect(checksummed, `mantleMainnet.${path} EIP-55 checksum mismatch`).toBe(value);
    }
  });

  it('Mantle Sepolia ERC-8004 addresses are populated (real testnet deployment)', () => {
    expect(ADDRESSES.mantleSepolia.erc8004.identityRegistry).not.toBe(ZERO);
    expect(ADDRESSES.mantleSepolia.erc8004.reputationRegistry).not.toBe(ZERO);
  });

  it('Mantle Sepolia pending-fill slots are exactly the documented set (story-192 lockbox)', () => {
    // If story-192 lands a real address, it must remove that slot from
    // SEPOLIA_PENDING_ADDRESS_SLOTS. If a Mainnet→Sepolia copy-paste accidentally re-zeros
    // a populated slot, this assertion fails.
    const actuallyPending = flattenAddresses(ADDRESSES.mantleSepolia)
      .filter(({ value }) => value === ZERO)
      .map(({ path }) => path)
      .sort();
    expect(actuallyPending).toEqual([...SEPOLIA_PENDING_ADDRESS_SLOTS]);
  });

  it('ADDRESSES tree is deeply frozen at runtime (registry is immutable)', () => {
    function assertFrozen(obj: unknown, path = 'ADDRESSES'): void {
      if (obj && typeof obj === 'object') {
        expect(Object.isFrozen(obj), `${path} must be frozen`).toBe(true);
        for (const [k, v] of Object.entries(obj)) assertFrozen(v, `${path}.${k}`);
      }
    }
    assertFrozen(ADDRESSES);
  });
});

describe('ADDRESSES Mainnet pinned values', () => {
  it.each<[string, Address]>([
    ['aave.pool', '0x458F293454fE0d67EC0655f3672301301DD51422'],
    ['aave.oracle', '0x47a063CfDa980532267970d478EC340C0F80E8df'],
    ['aave.addressesProvider', '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f'],
    ['aave.protocolDataProvider', '0x487c5c669D9eee6057C44973207101276cf73b68'],
    ['tokens.USDC', '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9'],
    ['tokens.USDe', '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34'],
    ['tokens.sUSDe', '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2'],
    ['tokens.WMNT', '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8'],
    ['tokens.WETH', '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111'],
    ['tokens.USDY', '0x5bE26527e817998A7206475496fDE1E68957c5A6'],
    ['tokens.mETH', '0xcDA86A272531e8640cD7F1a92c01839911B90bb0'],
    ['erc8004.identityRegistry', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
    ['erc8004.reputationRegistry', '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'],
    ['lifi.diamond', '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'],
    ['mantleDex.merchantMoe.lbRouter', '0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a'],
    ['mantleDex.agni.factory', '0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035'],
  ])('mainnet %s matches research/concierge/03-providers/', (path, expected) => {
    const got = path
      .split('.')
      .reduce<Record<string, unknown>>(
        (acc, key) => acc[key] as Record<string, unknown>,
        ADDRESSES.mantleMainnet as unknown as Record<string, unknown>,
      );
    expect(got).toBe(expected);
  });
});

describe('ADDRESSES Sepolia pinned values', () => {
  it.each<[string, Address]>([
    ['erc8004.identityRegistry', '0x8004A818BFB912233c491871b3d84c89A494BD9e'],
    ['erc8004.reputationRegistry', '0x8004B663056A597Dffe9eCcC1965A193B7388713'],
  ])('sepolia %s matches research/concierge/03-providers/erc8004.md', (path, expected) => {
    const got = path
      .split('.')
      .reduce<Record<string, unknown>>(
        (acc, key) => acc[key] as Record<string, unknown>,
        ADDRESSES.mantleSepolia as unknown as Record<string, unknown>,
      );
    expect(got).toBe(expected);
  });
});

describe('helpers', () => {
  it('addressesFor(5000) returns Mainnet block', () => {
    expect(addressesFor(5000)).toBe(ADDRESSES.mantleMainnet);
  });

  it('addressesFor(5003) returns Sepolia block', () => {
    expect(addressesFor(5003)).toBe(ADDRESSES.mantleSepolia);
  });

  it('addressesFor throws with descriptive message on unknown chain id', () => {
    expect(() => addressesFor(9999 as unknown as EvmChainId)).toThrow(/unsupported chain id: 9999/);
    expect(() => addressesFor(0 as unknown as EvmChainId)).toThrow(/unsupported chain id: 0/);
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

  it('chainFor throws with descriptive message on unknown chain id', () => {
    expect(() => chainFor(9999 as unknown as EvmChainId)).toThrow(/unsupported chain id: 9999/);
    expect(() => chainFor(0 as unknown as EvmChainId)).toThrow(/unsupported chain id: 0/);
  });
});

describe('AgentId', () => {
  const VALID = 'agent_0123456789abcdef0123456789abcdef';

  it('agentId() accepts a canonical-shaped string and round-trips', () => {
    const id = agentId(VALID);
    expect(id).toBe(VALID);
  });

  it('agentId() throws on a malformed input', () => {
    expect(() => agentId('agent_short')).toThrow(/Invalid AgentId/);
    expect(() => agentId('not-an-agent-id')).toThrow(/Invalid AgentId/);
    expect(() => agentId('')).toThrow(/Invalid AgentId/);
    expect(() => agentId('agent_0123456789abcdef0123456789ABCDEF')).toThrow(/Invalid AgentId/);
  });

  it('isAgentId() returns true for valid + false for invalid without throwing', () => {
    expect(isAgentId(VALID)).toBe(true);
    expect(isAgentId('not-an-agent-id')).toBe(false);
    expect(isAgentId('')).toBe(false);
  });
});

describe('type-level contracts (compile-time invariants)', () => {
  it('AgentId is a branded string (plain string not assignable)', () => {
    expectTypeOf<AgentId>().toMatchTypeOf<string>();
    expectTypeOf<string>().not.toMatchTypeOf<AgentId>();
  });

  it('EvmChainId is the 5000 | 5003 literal union (not widened to number)', () => {
    expectTypeOf<EvmChainId>().toEqualTypeOf<5000 | 5003>();
    expectTypeOf<number>().not.toMatchTypeOf<EvmChainId>();
  });

  it('TickPhase matches the canonical 6-phase architecture (plan → record, with decide)', () => {
    // Per docs/architecture.md repo-structure + story-60 routeModelForPhase.
    expectTypeOf<TickPhase>().toEqualTypeOf<
      'plan' | 'simulate' | 'propose' | 'decide' | 'execute' | 'record'
    >();
  });

  it('ProviderName matches packages/providers/* dir names exactly (7 arms)', () => {
    expectTypeOf<ProviderName>().toEqualTypeOf<
      | 'aave-v3-mantle'
      | 'mantle-dex'
      | 'ethena-susde'
      | 'ondo-usdy'
      | 'meth-staking'
      | 'lifi-bridge'
      | 'erc8004'
    >();
  });

  it('ActionKind has all 11 documented members', () => {
    expectTypeOf<ActionKind>().toEqualTypeOf<
      | 'supply'
      | 'borrow'
      | 'repay'
      | 'withdraw'
      | 'swap'
      | 'bridge'
      | 'stake'
      | 'unstake'
      | 'wrap'
      | 'unwrap'
      | 'attest'
    >();
  });
});
