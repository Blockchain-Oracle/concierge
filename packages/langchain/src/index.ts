// LangChain JS adapter for the framework-agnostic @concierge/tools registry
// (ADR-014). Outputs are JSON-stringified because LangChain's tool contract
// is string ToolMessage content (vs Vercel AI SDK's structured output).

import {
  type ConciergeAgentLike,
  type ConciergeTool,
  createConciergeTools,
  type ProviderToolFactory,
} from '@concierge/tools';
import { tool as lcTool, type StructuredToolInterface } from '@langchain/core/tools';

/**
 * Convert one ConciergeTool into a LangChain structured tool. The Concierge
 * `inputSchema` passes through by reference, so LangChain validates inputs
 * against the exact same Zod schema before delegating to `invoke`.
 */
export function toLangChainTool(t: ConciergeTool): StructuredToolInterface {
  return lcTool(async (args) => JSON.stringify(await t.invoke(args)), {
    name: t.name,
    description: t.description,
    schema: t.inputSchema,
  });
}

/**
 * Build a `bindTools`-ready `StructuredToolInterface[]` from the Concierge
 * registry. Mirrors `createConciergeTools(agent, providerToolFactories)`:
 * omitting the factories yields an empty array, and registry validation
 * errors (duplicate names, schema violations) propagate unchanged.
 *
 * Cancelling a LangChain run does NOT cancel an in-flight tool call —
 * `ConciergeTool.invoke` takes no abort signal, so a started execution
 * (e.g. an on-chain transaction) runs to completion.
 */
export function getLangChainTools(
  agent: ConciergeAgentLike,
  providerToolFactories?: ReadonlyArray<ProviderToolFactory>,
): StructuredToolInterface[] {
  return createConciergeTools(agent, providerToolFactories).map(toLangChainTool);
}
