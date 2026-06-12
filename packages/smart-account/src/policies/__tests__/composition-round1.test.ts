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
const USDC = '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' as Address;
const SUPPLY_SELECTOR = '0x617ba037' as Hex;
const TRANSFER_SELECTOR = '0xa9059cbb' as Hex;

function callParams(p: { policyParams: unknown }): {
  type: string;
  permissions?: ReadonlyArray<{
    target: Address;
    selector?: Hex;
    rules?: ReadonlyArray<{ condition: number; offset: number; params: readonly Hex[] }>;
  }>;
} {
  // biome-ignore lint/suspicious/noExplicitAny: narrowed by callers checking .type === 'call'
  return p.policyParams as any;
}

describe('createCallPolicy — round-1 hardening', () => {
  it('throws ConfigError when permissions array is empty at runtime', () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: bypassing the [T, ...T[]] type
      createCallPolicy({ permissions: [] as any });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('at least one');
    }
  });

  it('throws ConfigError when rules are present without a selector (wildcard+rules ambiguity)', () => {
    try {
      createCallPolicy({
        permissions: [
          {
            target: AAVE_POOL,
            rules: [
              {
                condition: ParamCondition.LESS_THAN_OR_EQUAL,
                offset: 32,
                params: [pad(toHex(1n), { size: 32 })],
              },
            ],
          },
        ],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('rules but no selector');
    }
  });

  it('throws ConfigError when selector is not a string (provider-edge type guard)', () => {
    try {
      createCallPolicy({
        // biome-ignore lint/suspicious/noExplicitAny: simulating an upstream provider returning non-string selector
        permissions: [{ target: AAVE_POOL, selector: 12345 as any }],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('must be a string');
    }
  });

  it('deep-clones rules so caller-side mutation does not weaken the policy', () => {
    const rules = [
      {
        condition: ParamCondition.LESS_THAN_OR_EQUAL,
        offset: 32,
        params: [pad(toHex(100n), { size: 32 })],
      },
    ];
    const policy = createCallPolicy({
      permissions: [{ target: AAVE_POOL, selector: TRANSFER_SELECTOR, rules }],
    });
    // Mutate the original rules array AND the inner params after handoff
    const r = rules[0] as { offset: number; params: Hex[] };
    r.params[0] = pad(toHex(999n), { size: 32 });
    r.offset = 999;
    const params = callParams(policy);
    expect(params.permissions?.[0]?.rules?.[0]?.offset).toBe(32);
    expect(params.permissions?.[0]?.rules?.[0]?.params?.[0]).toBe(pad(toHex(100n), { size: 32 }));
  });
});

describe('createErc20TransferLimit — round-1 hardening', () => {
  it('throws ConfigError for the zero-address token (silent no-op limit)', () => {
    try {
      createErc20TransferLimit({
        token: '0x0000000000000000000000000000000000000000' as Address,
        maxAmountPerTx: 1n,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('zero address');
    }
  });

  it('accepts UINT256_MAX as the inclusive upper boundary', () => {
    const UINT256_MAX = (1n << 256n) - 1n;
    const perm = createErc20TransferLimit({ token: USDC, maxAmountPerTx: UINT256_MAX });
    expect(perm.rules?.[0]?.params?.[0]).toBe(pad(toHex(UINT256_MAX), { size: 32 }));
  });
});

describe('createTimeFramePolicy — round-1 hardening', () => {
  it('throws ConfigError when validUntil === validAfter (equality boundary)', () => {
    try {
      createTimeFramePolicy({ validUntil: 1000, validAfter: 1000 });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('validUntil');
    }
  });

  it('defaults validUntil to 7 days AFTER an explicit-future validAfter', () => {
    const futureAfter = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const policy = createTimeFramePolicy({ validAfter: futureAfter });
    const params = policy.policyParams as { validUntil: number; validAfter: number };
    expect(params.validAfter).toBe(futureAfter);
    expect(params.validUntil).toBe(futureAfter + 7 * 24 * 60 * 60);
  });
});

describe('createConciergePolicy — round-1 hardening', () => {
  const provider1 = {
    sessionKey: {
      callPolicy: { permissions: [{ target: AAVE_POOL, selector: SUPPLY_SELECTOR }] },
    },
  };

  it('throws ConfigError for wildcard+specific in BOTH orders [specific, wildcard] AND [wildcard, specific]', () => {
    const wildcardProvider = {
      sessionKey: {
        callPolicy: { permissions: [{ target: AAVE_POOL } as CallPermission] },
      },
    };
    for (const order of [
      [wildcardProvider, provider1],
      [provider1, wildcardProvider],
    ] as const) {
      try {
        createConciergePolicy({
          providers: [order[0], order[1]],
          spendingLimits: [],
        });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ConciergeError);
        expect((e as ConciergeError).type).toBe('ConfigError');
        expect(String((e as ConciergeError).message)).toContain('wildcard');
      }
    }
  });

  it('accepts duplicate wildcard permissions on the same target (idempotent dedup)', () => {
    const wc1 = {
      sessionKey: {
        callPolicy: { permissions: [{ target: AAVE_POOL } as CallPermission] },
      },
    };
    const wc2 = {
      sessionKey: {
        callPolicy: { permissions: [{ target: AAVE_POOL } as CallPermission] },
      },
    };
    const policies = createConciergePolicy({
      providers: [wc1, wc2],
      spendingLimits: [],
    });
    const params = callParams(policies[0] as { policyParams: unknown });
    expect(params.permissions).toHaveLength(1);
  });

  it('throws ConfigError on asymmetric rule collision [ruled, unruled] AND [unruled, ruled]', () => {
    const ruled = {
      sessionKey: {
        callPolicy: {
          permissions: [createErc20TransferLimit({ token: USDC, maxAmountPerTx: 100n })],
        },
      },
    };
    const unruled = {
      sessionKey: {
        callPolicy: { permissions: [{ target: USDC, selector: TRANSFER_SELECTOR }] },
      },
    };
    for (const order of [
      [ruled, unruled],
      [unruled, ruled],
    ] as const) {
      try {
        createConciergePolicy({
          providers: [order[0], order[1]],
          spendingLimits: [],
        });
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ConciergeError);
        expect((e as ConciergeError).type).toBe('ConfigError');
        expect(String((e as ConciergeError).message)).toContain('one side carries rules');
      }
    }
  });
});

describe('createConciergePolicy — round-1 hardening (case + empty)', () => {
  const provider1 = {
    sessionKey: {
      callPolicy: { permissions: [{ target: AAVE_POOL, selector: SUPPLY_SELECTOR }] },
    },
  };

  it('rejects duplicate spendingLimits whose token addresses differ only in case', () => {
    try {
      createConciergePolicy({
        providers: [provider1],
        spendingLimits: [
          { token: USDC.toLowerCase() as Address, maxAmountPerTx: 1n },
          { token: USDC.toUpperCase() as Address, maxAmountPerTx: 2n },
        ],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('duplicate spendingLimits');
    }
  });

  it('throws ConfigError when providers collectively contribute zero permissions', () => {
    const empty = {
      sessionKey: { callPolicy: { permissions: [] as readonly CallPermission[] } },
    };
    try {
      createConciergePolicy({ providers: [empty], spendingLimits: [] });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('no permissions after merge');
    }
  });

  it('throws ConfigError with "both sides carry rules" message when BOTH providers carry rules on the same (target, selector)', () => {
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
      expect(String((e as ConciergeError).message)).toContain('both sides carries rules');
    }
  });
});

describe('createTimeFramePolicy — validAfter clamp behaviour', () => {
  it('clamps default validUntil to now + 7d when validAfter is in the past', () => {
    const now = Math.floor(Date.now() / 1000);
    const pastAfter = now - 3600;
    const policy = createTimeFramePolicy({ validAfter: pastAfter });
    const params = policy.policyParams as { validUntil: number; validAfter: number };
    // validUntil should be ~now+7d (NOT pastAfter+7d which would shorten the window)
    expect(params.validUntil).toBeGreaterThanOrEqual(now + 7 * 24 * 60 * 60 - 10);
    expect(params.validUntil).toBeLessThanOrEqual(now + 7 * 24 * 60 * 60 + 10);
  });

  it('throws ConfigError when validAfter > 1y in future without explicit validUntil (ms-vs-s guard)', () => {
    try {
      // 2 years in the future — would silently produce a 7-day window 2 years out
      // under the old default rule. New guard catches this.
      createTimeFramePolicy({
        validAfter: Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('milliseconds');
    }
  });

  it('Date.now() (milliseconds) passed as validAfter is rejected when validUntil is unspecified', () => {
    try {
      // The exact regression silent-failure IMPORTANT-2 flagged.
      createTimeFramePolicy({ validAfter: Date.now() });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect(String((e as ConciergeError).message)).toContain('milliseconds');
    }
  });

  it('accepts validAfter > 1y in future when validUntil is explicitly set (acknowledged long-lived intent)', () => {
    const farFuture = Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60;
    const policy = createTimeFramePolicy({
      validAfter: farFuture,
      validUntil: farFuture + 30 * 24 * 60 * 60,
    });
    const params = policy.policyParams as { validUntil: number; validAfter: number };
    expect(params.validAfter).toBe(farFuture);
  });
});
