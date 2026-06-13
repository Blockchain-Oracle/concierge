import { ConciergeError } from '@concierge/sdk';
import type { ToolSet } from 'ai';

/**
 * Execute-phase tool names that MUST NEVER appear in the plan toolset.
 * Curated from the 7 providers (story-30..36) — any new execute action
 * MUST be added here AND covered by the plan-phase guard test, otherwise
 * a regression silently widens plan's authority.
 */
export const PLAN_BANNED_TOOL_NAMES = Object.freeze([
  // Aave V3
  'supply',
  'borrow',
  'repay',
  'withdraw',
  'setUserEMode',
  // Mantle DEXes
  'swap',
  // Ethena sUSDe
  'wrapToSusde',
  'unwrapFromSusde',
  // Ondo USDY
  'wrapToUsdy',
  'redeemUsdy',
  // mETH staking
  'stakeMeth',
  'unstakeMeth',
  // Li.Fi bridge
  'bridge',
  // ERC-8004 attestation
  'attestAction',
  'giveFeedback',
] as const);

export type PlanBannedToolName = (typeof PLAN_BANNED_TOOL_NAMES)[number];

/**
 * Filters a Vercel AI ToolSet down to read-only tools by REMOVING any
 * banned execute tools. The PLAN phase passes the filtered set to
 * `streamText`'s `tools` param.
 *
 * Throws `ConfigError` when the result is empty — a plan phase with NO
 * read tools cannot make any meaningful decision and is almost certainly
 * a wiring bug (caller forgot to pass provider factories or filtered too
 * aggressively).
 *
 * Returns a fresh object (input not mutated) so callers can keep the full
 * ToolSet around for subsequent phases.
 */
export function filterToPlanTools(tools: ToolSet): ToolSet {
  const filtered: ToolSet = {};
  const banned: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if ((PLAN_BANNED_TOOL_NAMES as readonly string[]).includes(name)) {
      banned.push(name);
      continue;
    }
    filtered[name] = tool;
  }
  if (Object.keys(filtered).length === 0) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] filterToPlanTools: result is empty. Did you forget provider read-tool factories? Banned removed: ${banned.join(', ') || 'none'}.`,
    );
  }
  return filtered;
}

/**
 * Runtime assertion the caller can use to fail-loud if a banned tool name
 * is observed in a stream event (defense-in-depth — Vercel AI SDK should
 * already reject unknown tool names, but stories 63-67 may add custom
 * tool-call interceptors that could route around the registry).
 */
export function assertNotBanned(toolName: string): void {
  if ((PLAN_BANNED_TOOL_NAMES as readonly string[]).includes(toolName)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] plan-phase invariant violated — execute tool '${toolName}' attempted in plan phase.`,
    );
  }
}
