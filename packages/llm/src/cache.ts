import type Anthropic from '@anthropic-ai/sdk';

type ContentBlock = Anthropic.TextBlockParam;
type Tool = Anthropic.Tool;

const CACHE_EPHEMERAL = { type: 'ephemeral' as const };

/**
 * Anthropic prompt cache treats `system` + `tools` as ONE stable prefix.
 * The `cache_control: { type: 'ephemeral' }` marker on the LAST block of
 * the prefix breaks the cache boundary there — every prior block is cached.
 * Scope is per-organization (per API key) — cross-tenant poisoning is not
 * possible.
 *
 * Both arrays are SHALLOW-COPIED with the trailing block cloned, so the
 * caller's input is never mutated. Empty arrays are dropped from the result
 * (some SDK validation paths reject `tools: []`) AND warned to stderr —
 * empty system/tools is almost always a caller bug (forgot to attach the
 * prompt, or a filter dropped everything).
 */
export function markPrefixForCaching(args: {
  system?: readonly ContentBlock[];
  tools?: readonly Tool[];
}): { system?: ContentBlock[]; tools?: Tool[] } {
  const result: { system?: ContentBlock[]; tools?: Tool[] } = {};
  if (args.system !== undefined) {
    const marked = markLast(args.system, 'system');
    if (marked.length > 0) result.system = marked;
  }
  if (args.tools !== undefined) {
    const marked = markLast(args.tools, 'tools');
    if (marked.length > 0) result.tools = marked;
  }
  return result;
}

function markLast<T extends { cache_control?: unknown }>(
  arr: readonly T[],
  kind: 'system' | 'tools',
): T[] {
  if (arr.length === 0) {
    // biome-ignore lint/suspicious/noConsole: empty prefix is almost always a caller bug, surface it
    console.warn(
      `[@concierge/llm] markPrefixForCaching: empty ${kind} array — no cache_control marker inserted. Likely caller bug.`,
    );
    return [];
  }
  const copy = arr.slice();
  // Spread + cast: TS cannot prove the spread preserves T's identity for
  // generic T, but our two concrete instantiations (ContentBlock | Tool) are
  // sound — cache_control is a known field on both.
  copy[copy.length - 1] = {
    ...copy[copy.length - 1],
    cache_control: CACHE_EPHEMERAL,
  } as T;
  return copy;
}
