import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { LIFI_DIAMOND } from '../_context.ts';
import { BRIDGE_FUNCTION_SELECTORS, buildCallPolicy, callPolicy } from '../sessionKey.ts';

// Compute expected selectors from canonical ABI strings — same derivation as sessionKey.ts
const BD = '(bytes32,string,string,address,address,address,uint256,uint256,bool,bool)' as const;
const SD = '(address,address,address,address,uint256,bytes,bool)[]' as const;
const EXPECTED_ACROSS_START = toFunctionSelector(
  `startBridgeTokensViaAcrossV3(${BD},(address,address,address,uint256,uint256,uint32,int64,uint32,bytes))`,
);
const EXPECTED_ACROSS_SWAP_AND_START = toFunctionSelector(
  `swapAndStartBridgeTokensViaAcrossV3(${BD},${SD},(address,address,address,uint256,uint256,uint32,int64,uint32,bytes))`,
);
const EXPECTED_STARGATE_START = toFunctionSelector(
  `startBridgeTokensViaStargate(${BD},(uint32,uint16,address,uint256,uint256,bytes,address))`,
);
const EXPECTED_HOP_START = toFunctionSelector(
  `startBridgeTokensViaHop(${BD},(address,address,address,uint256,uint256,uint256,uint256,bytes32))`,
);

describe('callPolicy — restrictive session key policy (test_sessionKey_PolicyRestrictive)', () => {
  it('targets exactly one contract — the Li.Fi Diamond', () => {
    expect(callPolicy.targets.length).toBe(1);
    expect(callPolicy.targets[0].toLowerCase()).toBe(LIFI_DIAMOND.toLowerCase());
  });

  it('selectors are non-empty and each is a valid 4-byte hex string (NOT wildcard)', () => {
    expect(callPolicy.selectors.length).toBeGreaterThanOrEqual(1);
    for (const sel of callPolicy.selectors) {
      // 4-byte selector = 0x + 8 hex chars = 10 chars total
      expect(sel).toMatch(/^0x[0-9a-fA-F]{8}$/);
      // Not the zero selector (wildcard guard)
      expect(sel).not.toBe('0x00000000');
    }
  });

  it('BRIDGE_FUNCTION_SELECTORS contains all known bridge + swap-and-bridge selectors', () => {
    expect(BRIDGE_FUNCTION_SELECTORS.length).toBeGreaterThanOrEqual(4);
    // Verify specific known selectors by value (not just count)
    expect(BRIDGE_FUNCTION_SELECTORS).toContain(EXPECTED_ACROSS_START);
    expect(BRIDGE_FUNCTION_SELECTORS).toContain(EXPECTED_ACROSS_SWAP_AND_START);
    expect(BRIDGE_FUNCTION_SELECTORS).toContain(EXPECTED_STARGATE_START);
    expect(BRIDGE_FUNCTION_SELECTORS).toContain(EXPECTED_HOP_START);
    // All are unique
    const unique = new Set(BRIDGE_FUNCTION_SELECTORS);
    expect(unique.size).toBe(BRIDGE_FUNCTION_SELECTORS.length);
  });
});

describe('buildCallPolicy — dynamic policy from route calldata', () => {
  it('extracts whitelisted selector and returns single-selector policy for lifiDiamond', () => {
    // Use the Across selector — known to be in the whitelist
    const calldata = (EXPECTED_ACROSS_START +
      '0000000000000000000000000000000000000000000000000000000000000001') as `0x${string}`;
    const policy = buildCallPolicy(calldata);
    expect(policy.targets.length).toBe(1);
    expect(policy.targets[0].toLowerCase()).toBe(LIFI_DIAMOND.toLowerCase());
    expect(policy.selectors.length).toBe(1);
    expect(policy.selectors[0]).toBe(EXPECTED_ACROSS_START);
  });

  it('throws ConciergeError(ConfigError) when selector is not in the whitelist', async () => {
    const nonWhitelistedCalldata =
      '0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`;
    const { ConciergeError } = await import('@concierge/sdk');
    expect(() => buildCallPolicy(nonWhitelistedCalldata)).toThrow(ConciergeError);
    expect(() => buildCallPolicy(nonWhitelistedCalldata)).toSatisfy((fn: unknown) => {
      try {
        (fn as () => void)();
        return false;
      } catch (e) {
        return (
          e instanceof ConciergeError &&
          (e as InstanceType<typeof ConciergeError>).type === 'ConfigError'
        );
      }
    });
  });

  it('throws ConciergeError(ConfigError) for calldata of exactly 9 chars (boundary)', async () => {
    const { ConciergeError } = await import('@concierge/sdk');
    // 0x + 7 hex chars = 9 chars total — one char short of a valid selector
    expect(() => buildCallPolicy('0x1234567' as `0x${string}`)).toThrow(ConciergeError);
  });

  it('throws when calldata is shorter than 10 chars', () => {
    expect(() => buildCallPolicy('0x123' as `0x${string}`)).toThrow();
  });
});
