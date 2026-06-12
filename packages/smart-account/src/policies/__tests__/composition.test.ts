import { ConciergeError } from '@concierge/sdk';
import { ParamCondition } from '@zerodev/permissions/policies';
import type { Address, Hex } from 'viem';
import { pad, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { CallPermission } from '../callPolicy.ts';
import { createCallPolicy } from '../callPolicy.ts';
import { createConciergePolicy } from '../concierge.ts';
import { createErc20TransferLimit } from '../erc20TransferLimit.ts';
import { createTimeFramePolicy } from '../timeFramePolicy.ts';

const AAVE_POOL = '0x1111111111111111111111111111111111111111' as Address;
const LIFI_DIAMOND = '0x2222222222222222222222222222222222222222' as Address;
const USDC = '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' as Address;
const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' as Address;
const SUPPLY_SELECTOR = '0x617ba037' as Hex;
const TRANSFER_SELECTOR = '0xa9059cbb' as Hex;

function callParams(p: { policyParams: unknown }): {
  type: string;
  policyVersion?: string;
  permissions?: ReadonlyArray<{
    target: Address;
    selector?: Hex;
    rules?: ReadonlyArray<{ condition: number; offset: number; params: readonly Hex[] }>;
  }>;
} {
  // biome-ignore lint/suspicious/noExplicitAny: narrowed by callers checking .type === 'call'
  return p.policyParams as any;
}

describe('createCallPolicy', () => {
  it('returns a call Policy with permissions threaded through and selector lowercased', () => {
    // Mixed-case hex chars: regex allows them, callPolicy must canonicalize to lowercase
    const mixedSelector = '0x617BA037' as Hex;
    const policy = createCallPolicy({
      permissions: [
        { target: AAVE_POOL, selector: mixedSelector },
        { target: LIFI_DIAMOND, selector: TRANSFER_SELECTOR },
      ],
    });
    const params = callParams(policy);
    expect(params.type).toBe('call');
    expect(params.policyVersion).toBe('0.0.5');
    expect(params.permissions).toHaveLength(2);
    expect(params.permissions?.[0]).toMatchObject({
      target: AAVE_POOL,
      selector: SUPPLY_SELECTOR,
    });
    expect(params.permissions?.[1]).toMatchObject({
      target: LIFI_DIAMOND,
      selector: TRANSFER_SELECTOR,
    });
  });

  it.each([
    ['target', { target: 'not-an-address' as Address, selector: SUPPLY_SELECTOR }, 'target'],
    ['selector', { target: AAVE_POOL, selector: '0xZZZZ' as Hex }, 'selector'],
    ['fallback selector', { target: AAVE_POOL, selector: '0x00000000' as Hex }, 'fallback'],
  ])('throws ConfigError(InvalidPolicy) for invalid %s', (_label, perm, expectMsg) => {
    try {
      createCallPolicy({ permissions: [perm] });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('InvalidPolicy');
      expect(String((e as ConciergeError).message)).toContain(expectMsg);
    }
  });

  it('accepts a permission with no selector (target-only allowance)', () => {
    const policy = createCallPolicy({
      permissions: [{ target: AAVE_POOL }],
    });
    expect(callParams(policy).type).toBe('call');
  });

  it('threads rules through to the permission unchanged', () => {
    const limit = createErc20TransferLimit({ token: USDC, maxAmountPerTx: 100n });
    const policy = createCallPolicy({ permissions: [limit] });
    const params = callParams(policy);
    expect(params.permissions?.[0]?.rules?.[0]?.condition).toBe(ParamCondition.LESS_THAN_OR_EQUAL);
    expect(params.permissions?.[0]?.rules?.[0]?.offset).toBe(32);
  });
});

describe('createErc20TransferLimit', () => {
  it('builds a CallPermission with LTE rule at offset 32, params padded to bytes32', () => {
    const perm = createErc20TransferLimit({ token: USDC, maxAmountPerTx: 100_000_000n });
    expect(perm.target).toBe(USDC);
    expect(perm.selector).toBe(TRANSFER_SELECTOR);
    expect(perm.rules).toHaveLength(1);
    const rule = perm.rules?.[0];
    expect(rule?.condition).toBe(ParamCondition.LESS_THAN_OR_EQUAL);
    expect(rule?.offset).toBe(32);
    expect(rule?.params).toEqual([pad(toHex(100_000_000n), { size: 32 })]);
  });

  it.each([
    ['invalid token', { token: 'nope' as Address, maxAmountPerTx: 1n }, 'token'],
    ['zero maxAmountPerTx', { token: USDC, maxAmountPerTx: 0n }, 'maxAmountPerTx'],
    ['negative maxAmountPerTx', { token: USDC, maxAmountPerTx: -1n }, 'maxAmountPerTx'],
    ['overflow maxAmountPerTx', { token: USDC, maxAmountPerTx: 1n << 256n }, 'exceeds uint256'],
  ])('throws ConfigError for %s', (_label, cfg, msg) => {
    try {
      createErc20TransferLimit(cfg);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain(msg);
    }
  });
});

describe('createTimeFramePolicy', () => {
  it('defaults validUntil to ~7 days from now and validAfter to ~now', () => {
    const now = Math.floor(Date.now() / 1000);
    const policy = createTimeFramePolicy({});
    const params = policy.policyParams as { validUntil: number; validAfter: number };
    expect(params.validUntil).toBeGreaterThanOrEqual(now + 7 * 24 * 60 * 60 - 30);
    expect(params.validUntil).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 + 30);
    expect(params.validAfter).toBeGreaterThanOrEqual(now - 30);
    expect(params.validAfter).toBeLessThanOrEqual(now + 30);
  });

  it('respects explicit validUntil + validAfter', () => {
    const policy = createTimeFramePolicy({ validUntil: 2_000_000_000, validAfter: 1_000_000_000 });
    const params = policy.policyParams as { validUntil: number; validAfter: number };
    expect(params.validUntil).toBe(2_000_000_000);
    expect(params.validAfter).toBe(1_000_000_000);
  });

  it.each([
    ['validUntil <= validAfter', { validUntil: 100, validAfter: 200 }, 'validUntil'],
    ['validUntil=0', { validUntil: 0 }, 'no expiry'],
    ['validUntil non-integer', { validUntil: 1.5 }, 'integer'],
    ['validUntil negative', { validUntil: -1 }, 'integer'],
    ['validUntil NaN', { validUntil: Number.NaN }, 'integer'],
    ['validUntil > uint48 max', { validUntil: 281_474_976_710_656 }, 'integer'],
    ['validAfter > uint48 max', { validAfter: Number.MAX_SAFE_INTEGER }, 'integer'],
  ])('throws ConfigError for %s', (_label, cfg, msg) => {
    try {
      createTimeFramePolicy(cfg);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain(msg);
    }
  });
});

describe('createConciergePolicy', () => {
  const provider1 = {
    sessionKey: {
      callPolicy: { permissions: [{ target: AAVE_POOL, selector: SUPPLY_SELECTOR }] },
    },
  };
  const provider2 = {
    sessionKey: {
      callPolicy: { permissions: [{ target: LIFI_DIAMOND, selector: TRANSFER_SELECTOR }] },
    },
  };

  it('returns exactly 2 policies: [merged call policy, time-frame]', () => {
    const policies = createConciergePolicy({
      providers: [provider1, provider2],
      spendingLimits: [{ token: USDC, maxAmountPerTx: 100_000_000n }],
    });
    expect(policies).toHaveLength(2);
    expect(policies[0]?.policyParams.type).toBe('call');
    expect(policies[1]?.policyParams.type).toBe('timestamp');
  });

  it('merged call policy contains union of provider permissions + spending-limit rule', () => {
    const policies = createConciergePolicy({
      providers: [provider1, provider2],
      spendingLimits: [{ token: USDC, maxAmountPerTx: 100_000_000n }],
    });
    const params = callParams(policies[0] as { policyParams: unknown });
    expect(params.permissions).toHaveLength(3);
    const targets = params.permissions?.map((p) => p.target.toLowerCase());
    expect(targets).toContain(AAVE_POOL.toLowerCase());
    expect(targets).toContain(LIFI_DIAMOND.toLowerCase());
    expect(targets).toContain(USDC.toLowerCase());
    const usdcPerm = params.permissions?.find((p) => p.target.toLowerCase() === USDC.toLowerCase());
    expect(usdcPerm?.selector).toBe(TRANSFER_SELECTOR);
    expect(usdcPerm?.rules?.[0]?.condition).toBe(ParamCondition.LESS_THAN_OR_EQUAL);
  });

  it('dedups (target, selector) across providers — including case-insensitive selector', () => {
    const dupProvider = {
      sessionKey: {
        callPolicy: {
          permissions: [{ target: AAVE_POOL, selector: '0x617BA037' as Hex }],
        },
      },
    };
    const policies = createConciergePolicy({
      providers: [provider1, dupProvider],
      spendingLimits: [],
    });
    const params = callParams(policies[0] as { policyParams: unknown });
    expect(params.permissions).toHaveLength(1);
  });

  it('throws ConfigError when providers array is empty', () => {
    try {
      createConciergePolicy({
        // biome-ignore lint/suspicious/noExplicitAny: bypass non-empty type for runtime check
        providers: [] as any,
        spendingLimits: [],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('at least one provider');
    }
  });
});

describe('createConciergePolicy — conflict detection', () => {
  const provider1 = {
    sessionKey: {
      callPolicy: { permissions: [{ target: AAVE_POOL, selector: SUPPLY_SELECTOR }] },
    },
  };

  it('throws ConfigError when wildcard selector overlaps a specific selector on the same target', () => {
    const wildcardProvider = {
      sessionKey: {
        callPolicy: { permissions: [{ target: AAVE_POOL } as CallPermission] },
      },
    };
    try {
      createConciergePolicy({
        providers: [provider1, wildcardProvider],
        spendingLimits: [],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('wildcard');
    }
  });

  it('throws ConfigError when two spendingLimits target the same token', () => {
    try {
      createConciergePolicy({
        providers: [provider1],
        spendingLimits: [
          { token: USDC, maxAmountPerTx: 1n },
          { token: USDC, maxAmountPerTx: 2n },
        ],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('duplicate spendingLimits');
    }
  });

  it('accepts multiple distinct-token spendingLimits', () => {
    const policies = createConciergePolicy({
      providers: [provider1],
      spendingLimits: [
        { token: USDC, maxAmountPerTx: 1n },
        { token: USDE, maxAmountPerTx: 2n },
      ],
    });
    const params = callParams(policies[0] as { policyParams: unknown });
    const targets = params.permissions?.map((p) => p.target.toLowerCase());
    expect(targets).toContain(USDC.toLowerCase());
    expect(targets).toContain(USDE.toLowerCase());
  });

  it('accepts a custom validUntil and validAfter and threads them through', () => {
    const customValidUntil = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
    const customValidAfter = Math.floor(Date.now() / 1000) - 60;
    const policies = createConciergePolicy({
      providers: [provider1],
      spendingLimits: [],
      validUntil: customValidUntil,
      validAfter: customValidAfter,
    });
    const tsParams = policies[1]?.policyParams as { validUntil: number; validAfter: number };
    expect(tsParams.validUntil).toBe(customValidUntil);
    expect(tsParams.validAfter).toBe(customValidAfter);
  });

  it('throws ConfigError when same (target, selector) appears with conflicting rules', () => {
    const ruled1 = {
      sessionKey: {
        callPolicy: {
          permissions: [createErc20TransferLimit({ token: USDC, maxAmountPerTx: 100n })],
        },
      },
    };
    const ruled2 = {
      sessionKey: {
        callPolicy: {
          permissions: [createErc20TransferLimit({ token: USDC, maxAmountPerTx: 200n })],
        },
      },
    };
    try {
      createConciergePolicy({
        providers: [ruled1, ruled2],
        spendingLimits: [],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('conflicting permissions');
    }
  });
});
