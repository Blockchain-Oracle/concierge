import { ConciergeError } from '@concierge/sdk';
import {
  type CallPolicyParams,
  CallPolicyVersion,
  type ParamCondition,
  toCallPolicy,
} from '@zerodev/permissions/policies';
import type { Address, Hex } from 'viem';
import { isAddress } from 'viem';

/** Rule fragment matching ZeroDev's ParamRule for V0_0_5 (params is bytes32[], audit §19). */
export interface CallPermissionRule {
  readonly condition: ParamCondition;
  readonly offset: number;
  readonly params: readonly Hex[];
}

/**
 * A single call-policy entry binding a target contract to (optionally) a function
 * selector and (optionally) per-param rules.
 *
 * **`selector === undefined` is a WILDCARD** that whitelists every function on
 * `target`. Use sparingly — the composer (`createConciergePolicy`) treats a
 * wildcard as collapsing any specific-selector entry on the same target.
 */
export interface CallPermission {
  readonly target: Address;
  readonly selector?: Hex;
  readonly rules?: readonly CallPermissionRule[];
}

export interface CreateCallPolicyConfig {
  /** Non-empty — an empty call policy denies all calls. */
  readonly permissions: readonly [CallPermission, ...CallPermission[]];
}

const SELECTOR_REGEX = /^0x[0-9a-fA-F]{8}$/;
const FALLBACK_SELECTOR = '0x00000000';

/**
 * Strict input validation around `toCallPolicy`. Lowercases the selector before
 * passing through so downstream dedup / encoding can rely on canonical form.
 * Bad input throws `ConciergeError('ConfigError', 'InvalidPolicy: ...')` —
 * never silently permissive (CLAUDE.md non-negotiable).
 */
export function createCallPolicy(config: CreateCallPolicyConfig): ReturnType<typeof toCallPolicy> {
  // Runtime non-empty check — the [T, ...T[]] type only enforces at compile time;
  // a `permissions: [] as any` caller would silently produce a deny-all policy.
  if (!Array.isArray(config.permissions) || config.permissions.length === 0) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] createCallPolicy: InvalidPolicy: permissions must contain at least one entry — an empty call policy would deny all calls.',
    );
  }
  const normalized = config.permissions.map((perm, i) => {
    if (!isAddress(perm.target)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] createCallPolicy: InvalidPolicy: permissions[${i}].target is not a valid address: '${perm.target}'`,
      );
    }
    if (perm.selector !== undefined) {
      if (typeof perm.selector !== 'string') {
        throw new ConciergeError(
          'ConfigError',
          `[@concierge/smart-account] createCallPolicy: InvalidPolicy: permissions[${i}].selector must be a string, got ${typeof perm.selector}.`,
        );
      }
      if (!SELECTOR_REGEX.test(perm.selector)) {
        throw new ConciergeError(
          'ConfigError',
          `[@concierge/smart-account] createCallPolicy: InvalidPolicy: permissions[${i}].selector is not a 4-byte hex string (expected 0x-prefixed 8 hex chars): '${perm.selector}'`,
        );
      }
      if (perm.selector.toLowerCase() === FALLBACK_SELECTOR) {
        throw new ConciergeError(
          'ConfigError',
          `[@concierge/smart-account] createCallPolicy: InvalidPolicy: permissions[${i}].selector '0x00000000' is the fallback/receive selector — refusing to grant it as a regular allowance.`,
        );
      }
    }
    if (perm.rules !== undefined && perm.rules.length > 0 && perm.selector === undefined) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] createCallPolicy: InvalidPolicy: permissions[${i}] has rules but no selector — rules are calldata-offset-indexed and meaningless without a defined function selector.`,
      );
    }
    return {
      target: perm.target,
      ...(perm.selector !== undefined && { selector: perm.selector.toLowerCase() as Hex }),
      // Deep clone rules + their params arrays so the returned policy can't be
      // weakened by a caller mutating the original rule objects post-hand-off.
      ...(perm.rules !== undefined && {
        rules: perm.rules.map((r) => ({ ...r, params: [...r.params] })),
      }),
    };
  });
  const params = {
    policyVersion: CallPolicyVersion.V0_0_5,
    // biome-ignore lint/suspicious/noExplicitAny: our CallPermissionRule.params is readonly Hex[]; ZeroDev's ParamRule.params is Hex | Hex[]. Structurally compatible after deep clone.
    permissions: normalized as any,
  } as CallPolicyParams;
  return toCallPolicy(params);
}
