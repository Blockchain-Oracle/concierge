// ConciergeTool — single source of truth for every adapter (Vercel AI / OpenAI / LangChain / AgentKit / MCP / React UI).
// Implements ADR-014. Differences from the ADR's verbatim form, applied for tighter invariants:
//  - `chainId` narrowed to `EvmChainId` from @concierge/shared (vs bare `number`).
//  - `UICardId` is the four-arm v1 set; `'plan'` / `'data-table'` are post-v1 (need an ADR amendment).
//  - `outputSchema` constrained to `z.ZodObject` per ADR-017 (MCP structuredContent needs an object at top level).

import type { EvmChainId } from '@concierge/shared';
import type { z } from 'zod';

export type { TickLoopPhase as TickPhase } from '@concierge/shared';

/** UI card identifiers; each id MUST have a matching SerializableXxxCardSchema (caught by CARD_SCHEMAS' `satisfies` in serializable.ts). */
export type UICardId = 'proposal' | 'tick' | 'portfolio' | 'reputation';

export interface ConciergeTool<
  TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  // biome-ignore lint/suspicious/noExplicitAny: ZodObject's shape param defaults to z.ZodRawShape; using any here lets adapters compose without specifying the shape generic at every callsite.
  TOutputSchema extends z.ZodObject<any> = z.ZodObject<z.ZodRawShape>,
> {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  uiCardId?: UICardId;
  invoke(args: z.infer<TInputSchema>): Promise<z.infer<TOutputSchema>>;
  supportsNetwork?(chainId: EvmChainId): boolean;
}

/** Minimum agent shape `createConciergeTools` needs for chain-gated filtering. */
export interface ConciergeAgentLike {
  chainId: EvmChainId;
}

/**
 * Each provider package exports one of these as `tools`; the agent constructor composes them.
 * Generic narrowing is intentionally erased at the boundary — adapters dispatch by `t.name`
 * at runtime; per-tool inference belongs at the tool-definition site (via `tool()`), not here.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate erasure — see comment above.
export type ProviderToolFactory = (agent: ConciergeAgentLike) => Array<ConciergeTool<any, any>>;
