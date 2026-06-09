// Runtime helper tests: addressesFor, chainFor, assertNumericChainId, AgentId constructors + conversions.

import { describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  addressesFor,
  agentId,
  agentIdFromHex,
  agentIdFromJSON,
  agentIdToHex,
  agentIdToJSON,
  assertNumericChainId,
  chainFor,
  isAgentId,
  mantleMainnet,
  mantleSepolia,
} from './index.ts';

describe('addressesFor', () => {
  it('returns Mainnet block on 5000', () => {
    expect(addressesFor(5000)).toBe(ADDRESSES.mantleMainnet);
  });

  it('returns Sepolia block on 5003', () => {
    expect(addressesFor(5003)).toBe(ADDRESSES.mantleSepolia);
  });

  it('throws TypeError on string chainId (env / JSON trap)', () => {
    expect(() => addressesFor('5000' as unknown as 5000)).toThrow(TypeError);
    expect(() => addressesFor('5000' as unknown as 5000)).toThrow(
      /must be a positive safe integer/,
    );
  });

  it('throws TypeError on bigint chainId', () => {
    expect(() => addressesFor(5000n as unknown as 5000)).toThrow(TypeError);
  });

  it('throws on unknown positive numeric chain id', () => {
    expect(() => addressesFor(9999 as unknown as 5000)).toThrow(/unsupported Mantle chain id 9999/);
  });

  it('throws on zero (assertNumericChainId rejects before chain-id branch)', () => {
    expect(() => addressesFor(0 as unknown as 5000)).toThrow(/positive safe integer/);
  });
});

describe('chainFor', () => {
  it('returns viem mantle mainnet on 5000', () => {
    expect(chainFor(5000)).toBe(mantleMainnet);
    expect(chainFor(5000).id).toBe(5000);
  });

  it('returns Mantle Sepolia config on 5003 (testnet=true)', () => {
    expect(chainFor(5003)).toBe(mantleSepolia);
    expect(chainFor(5003).id).toBe(5003);
    expect(chainFor(5003).testnet).toBe(true);
  });

  it('throws TypeError on string chainId', () => {
    expect(() => chainFor('5003' as unknown as 5003)).toThrow(TypeError);
  });

  it('throws on unknown chain id', () => {
    expect(() => chainFor(9999 as unknown as 5000)).toThrow(/unsupported Mantle chain id 9999/);
  });

  it('Mantle Sepolia chain has multicall3 contract (silent-failure guard)', () => {
    // Verified live via cast call 2026-06-09; see chains.ts header.
    // Without this, publicClient.multicall() silently degrades on Sepolia only.
    expect(mantleSepolia.contracts?.multicall3?.address).toBe(
      '0xcA11bde05977b3631167028862bE2a173976CA11',
    );
  });

  it('Mantle Mainnet pins canonical Multicall3 address (catches viem upstream drift)', () => {
    expect(mantleMainnet.contracts?.multicall3?.address).toBe(
      '0xcA11bde05977b3631167028862bE2a173976CA11',
    );
  });

  it('Sepolia chain shape is viem-multicall-compatible (Chain.contracts.multicall3.address)', () => {
    const mc = mantleSepolia.contracts?.multicall3;
    expect(mc).toMatchObject({ address: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/) });
  });

  it('chainFor surfaces the fn name in the TypeError message', () => {
    expect(() => chainFor('5003' as unknown as 5003)).toThrow(/chainFor: chainId must be/);
  });
});

describe('assertNumericChainId', () => {
  it('accepts positive integer numbers', () => {
    expect(() => assertNumericChainId(5000, 'test')).not.toThrow();
    expect(() => assertNumericChainId(5003, 'test')).not.toThrow();
  });

  it('throws on float, string, bigint, null, undefined', () => {
    expect(() => assertNumericChainId(5000.5, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId('5000', 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(5000n, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(null, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(undefined, 'test')).toThrow(TypeError);
  });

  it('rejects zero, negative, NaN, Infinity, and unsafe-integer values', () => {
    expect(() => assertNumericChainId(0, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(-1, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(Number.NaN, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(Number.POSITIVE_INFINITY, 'test')).toThrow(TypeError);
    expect(() => assertNumericChainId(Number.MAX_SAFE_INTEGER + 1, 'test')).toThrow(TypeError);
  });

  it('interpolates fnName into the error message + suggests Number() parsing', () => {
    expect(() => assertNumericChainId('5000', 'myFn')).toThrow(/myFn: chainId must be/);
    expect(() => assertNumericChainId('5000', 'myFn')).toThrow(/parse with Number\(\) first/);
  });
});

// Synthetic test fixture — recognizable pattern, low entropy (gitleaks-safe).
const SAMPLE_TOKEN_ID = 0xdeadbeefn;
const SAMPLE_HEX = '0x00000000000000000000000000000000000000000000000000000000deadbeef';

describe('AgentId construction (branded bigint per ERC-8004 uint256 tokenId)', () => {
  it('agentId() accepts a valid bigint and round-trips', () => {
    expect(agentId(SAMPLE_TOKEN_ID)).toBe(SAMPLE_TOKEN_ID);
  });

  it('agentId() accepts zero (ERC-721 collections may start at 0)', () => {
    expect(() => agentId(0n)).not.toThrow();
  });

  it('agentId() rejects negative bigints', () => {
    expect(() => agentId(-1n)).toThrow(RangeError);
    expect(() => agentId(-1n)).toThrow(/must be non-negative/);
  });

  it('agentId() rejects values >= 2^256 (uint256 overflow)', () => {
    expect(() => agentId(2n ** 256n)).toThrow(RangeError);
    expect(() => agentId(2n ** 256n)).toThrow(/exceeds uint256/);
  });

  it('agentId() rejects non-bigint inputs (number, string)', () => {
    expect(() => agentId(123 as unknown as bigint)).toThrow(TypeError);
    expect(() => agentId('123' as unknown as bigint)).toThrow(TypeError);
  });

  it('isAgentId() accepts unknown input + returns boolean without throwing', () => {
    expect(isAgentId(SAMPLE_TOKEN_ID)).toBe(true);
    expect(isAgentId(0n)).toBe(true);
    expect(isAgentId(-1n)).toBe(false);
    expect(isAgentId(2n ** 256n)).toBe(false);
    expect(isAgentId(123)).toBe(false);
    expect(isAgentId('123')).toBe(false);
    expect(isAgentId(null)).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });
});

describe('AgentId hex conversion', () => {
  it('agentIdFromHex() parses a 0x-prefixed hex into an AgentId', () => {
    expect(agentIdFromHex(SAMPLE_HEX)).toBe(SAMPLE_TOKEN_ID);
  });

  it('agentIdToHex() emits canonical uint256-padded hex (64 hex chars)', () => {
    const id = agentId(SAMPLE_TOKEN_ID);
    const hex = agentIdToHex(id);
    expect(hex).toBe(SAMPLE_HEX);
    expect(hex).toHaveLength(66);
  });

  it('hex → id → hex is a stable round-trip', () => {
    const id = agentIdFromHex(SAMPLE_HEX);
    expect(agentIdToHex(id)).toBe(SAMPLE_HEX);
  });

  it('agentIdToHex pads zero AgentId to 64 hex chars', () => {
    expect(agentIdToHex(agentId(0n))).toBe(`0x${'0'.repeat(64)}`);
  });

  it('round-trips at the max-uint256 boundary', () => {
    const MAX = 2n ** 256n - 1n;
    const hex = `0x${'f'.repeat(64)}` as const;
    expect(agentIdToHex(agentId(MAX))).toBe(hex);
    expect(agentIdFromHex(hex)).toBe(MAX);
  });

  it('agentIdFromHex normalizes mixed-case input to lowercase output', () => {
    const id = agentIdFromHex('0xDeAdBeEf' as `0x${string}`);
    expect(agentIdToHex(id)).toMatch(/^0x[0-9a-f]+$/);
    expect(agentIdToHex(id)).not.toMatch(/[A-F]/);
  });

  it('agentIdFromHex rejects malformed input with [@concierge/shared] prefix', () => {
    expect(() => agentIdFromHex('0x' as `0x${string}`)).toThrow(
      /\[@concierge\/shared\] agentIdFromHex/,
    );
    expect(() => agentIdFromHex('0xZZ' as `0x${string}`)).toThrow(
      /\[@concierge\/shared\] agentIdFromHex/,
    );
    expect(() => agentIdFromHex('not-hex' as `0x${string}`)).toThrow(
      /\[@concierge\/shared\] agentIdFromHex/,
    );
  });

  it('agentIdFromHex rejects hex that overflows uint256', () => {
    expect(() => agentIdFromHex(`0x1${'0'.repeat(64)}` as `0x${string}`)).toThrow(
      /exceeds uint256/,
    );
  });
});

describe('AgentId JSON boundary', () => {
  it('agentIdToJSON + agentIdFromJSON survive the JSON.stringify boundary', () => {
    const id = agentId(SAMPLE_TOKEN_ID);
    const serialized = JSON.stringify({ agentId: agentIdToJSON(id) });
    const parsed = JSON.parse(serialized) as { agentId: string };
    expect(agentIdFromJSON(parsed.agentId)).toBe(id);
  });

  it('JSON.stringify on a raw AgentId throws (BigInt limitation — use agentIdToJSON)', () => {
    expect(() => JSON.stringify({ id: agentId(1n) })).toThrow(TypeError);
  });
});
