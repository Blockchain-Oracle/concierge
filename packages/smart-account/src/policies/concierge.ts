import { ConciergeError } from '@concierge/sdk';
import type { toCallPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';
import type { Address } from 'viem';
import { type CallPermission, createCallPolicy } from './callPolicy.ts';
import { createErc20TransferLimit, type Erc20TransferLimitConfig } from './erc20TransferLimit.ts';
import { createTimeFramePolicy } from './timeFramePolicy.ts';

/**
 * Shape providers (story-32, story-40, …) export under `provider.sessionKey.callPolicy`.
 * Source of truth for which contracts + functions the provider's tools touch — composed
 * here into the agent's session-key policy bundle.
 */
export interface ProviderSessionKeyShape {
  readonly sessionKey: { readonly callPolicy: { readonly permissions: readonly CallPermission[] } };
}

export interface CreateConciergePolicyConfig {
  /** Non-empty — at least one provider required. */
  readonly providers: readonly [ProviderSessionKeyShape, ...ProviderSessionKeyShape[]];
  /** Per-token ERC-20 transfer caps. May be empty (agent might be allowance-free). */
  readonly spendingLimits: readonly Erc20TransferLimitConfig[];
  /** Unix SECONDS. Defaults to now + 7 days. */
  readonly validUntil?: number;
  /** Unix SECONDS. Defaults to now. */
  readonly validAfter?: number;
}

type Policy = ReturnType<typeof toCallPolicy> | ReturnType<typeof toTimestampPolicy>;

function canonicalSelector(p: CallPermission): string {
  return p.selector === undefined ? '*' : p.selector.toLowerCase();
}

function canonicalTarget(p: CallPermission): string {
  return (p.target as Address).toLowerCase();
}

/**
 * Merge a list of permissions deduping by (lowercased target, lowercased selector).
 * Throws on conflicts where merge semantics would silently drop a constraint:
 *   - same (target, selector) appearing twice with different rule sets → ambiguity
 *   - wildcard selector on a target that has any specific-selector entry → wildcard
 *     would broaden the specific entry, voiding the per-function restriction
 */
function mergePermissions(perms: readonly CallPermission[]): CallPermission[] {
  const byKey = new Map<string, CallPermission>();
  const targetsWithSpecific = new Set<string>();
  const targetsWithWildcard = new Set<string>();
  for (const p of perms) {
    const target = canonicalTarget(p);
    const sel = canonicalSelector(p);
    if (sel === '*') targetsWithWildcard.add(target);
    else targetsWithSpecific.add(target);
    const key = `${target}::${sel}`;
    const existing = byKey.get(key);
    if (existing) {
      const existingHasRules = existing.rules !== undefined && existing.rules.length > 0;
      const newHasRules = p.rules !== undefined && p.rules.length > 0;
      if (existingHasRules || newHasRules) {
        const which = existingHasRules && newHasRules ? 'both sides' : 'one side';
        throw new ConciergeError(
          'ConfigError',
          `[@concierge/smart-account] createConciergePolicy: InvalidPolicy: conflicting permissions on (target=${target}, selector=${sel}) — ${which} carries rules; merging would silently drop a constraint.`,
        );
      }
      continue;
    }
    byKey.set(key, p);
  }
  for (const t of targetsWithWildcard) {
    if (targetsWithSpecific.has(t)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] createConciergePolicy: InvalidPolicy: target ${t} has both a wildcard permission (no selector) and a specific-selector permission — the wildcard would void the specific restriction. Either remove the wildcard or list specific selectors explicitly.`,
      );
    }
  }
  return [...byKey.values()];
}

/**
 * Composes per-provider call permissions + per-token ERC-20 transfer caps + a
 * time-frame window into a `Policy[]` suitable for
 * `toPermissionValidator({ policies })`.
 *
 * Spending limits are MERGED INTO the call policy as rule-bearing permissions —
 * sibling policies are AND'd by ZeroDev's validator and cannot enforce a limit
 * that the call policy itself doesn't allow. The composer therefore:
 *   1. Collects provider permissions into a merge set
 *   2. For each spending limit, adds an `(token, transfer, rule=LTE amount)`
 *      permission to the same set — collisions throw `ConfigError`
 *   3. Builds a single merged call policy
 *   4. Appends the time-frame policy
 *
 * Bad inputs throw `ConciergeError('ConfigError', 'InvalidPolicy: ...')` at
 * composition time — never silently produces a permissive policy.
 */
export function createConciergePolicy(config: CreateConciergePolicyConfig): readonly Policy[] {
  if (config.providers.length === 0) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] createConciergePolicy: InvalidPolicy: at least one provider required — empty policy bundle would issue an unconstrained session key.',
    );
  }
  // Validate spending-limit token uniqueness up-front (clearer error than the
  // generic merge-collision message that would otherwise fire).
  const seenTokens = new Set<string>();
  for (const limit of config.spendingLimits) {
    const t = (limit.token as Address).toLowerCase();
    if (seenTokens.has(t)) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] createConciergePolicy: InvalidPolicy: duplicate spendingLimits entry for token ${limit.token} — multiple LTE rules on the same (token, transfer) permission are not supported.`,
      );
    }
    seenTokens.add(t);
  }

  const providerPermissions = config.providers.flatMap((p) => p.sessionKey.callPolicy.permissions);
  const limitPermissions = config.spendingLimits.map((l) => createErc20TransferLimit(l));
  const merged = mergePermissions([...providerPermissions, ...limitPermissions]);
  if (merged.length === 0) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] createConciergePolicy: InvalidPolicy: no permissions after merge — providers contributed an empty allow-list.',
    );
  }
  const policies: Policy[] = [
    createCallPolicy({ permissions: merged as [CallPermission, ...CallPermission[]] }),
    createTimeFramePolicy({
      ...(config.validUntil !== undefined && { validUntil: config.validUntil }),
      ...(config.validAfter !== undefined && { validAfter: config.validAfter }),
    }),
  ];
  return policies;
}
