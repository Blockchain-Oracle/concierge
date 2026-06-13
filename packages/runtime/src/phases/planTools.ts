import { ConciergeError } from '@concierge/sdk';
import type { ToolSet } from 'ai';

/**
 * Execute-phase tool names that MUST NEVER appear in the plan toolset.
 * Hand-curated denylist — story-300 will introduce an allowlist via
 * tool.metadata.phase tag (CWE-276 defense). Until then, additions to
 * any provider's execute surface MUST also land here.
 */
export const PLAN_BANNED_TOOL_NAMES = Object.freeze([
  'supply',
  'borrow',
  'repay',
  'withdraw',
  'setUserEMode',
  'swap',
  'wrapToSusde',
  'unwrapFromSusde',
  'wrapToUsdy',
  'redeemUsdy',
  'stakeMeth',
  'unstakeMeth',
  'bridge',
  'attestAction',
  'giveFeedback',
] as const);

export type PlanBannedToolName = (typeof PLAN_BANNED_TOOL_NAMES)[number];

const BANNED_SET: ReadonlySet<string> = new Set(PLAN_BANNED_TOOL_NAMES);

export function isBannedToolName(name: string): name is PlanBannedToolName {
  return BANNED_SET.has(name);
}

/**
 * Strip banned execute tools from the ToolSet. Throws ConfigError if the
 * filter leaves nothing — that's a wiring bug, not a silent skip.
 * Returns a fresh object; input not mutated.
 */
export function filterToPlanTools(tools: ToolSet): ToolSet {
  const filtered: ToolSet = {};
  const banned: string[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (BANNED_SET.has(name)) {
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
