// LangChain JS adapter for the framework-agnostic @concierge/tools registry
// (ADR-014). Outputs are stringified via bigintSafeStringify so ToolMessage
// content is a deterministic string under the adapter's control: LangChain
// v1 would otherwise coerce objects itself (its tool output type is `any`),
// turning an `undefined` return into a silent empty-success message and
// throwing cryptically on wei-scale bigint values.

import {
  bigintSafeStringify,
  type ConciergeAgentLike,
  type ConciergeTool,
  createConciergeTools,
  type ProviderToolFactory,
} from '@concierge/tools';
import { tool as lcTool, type StructuredToolInterface } from '@langchain/core/tools';

/**
 * Convert one ConciergeTool into a LangChain structured tool. The Concierge
 * `inputSchema` passes through by reference, so LangChain parses inputs with
 * the exact same Zod schema before delegating — `invoke` receives the PARSED
 * value (defaults applied, unknown keys stripped), never the raw args.
 *
 * The tool must satisfy the registry invariants (a Zod OBJECT inputSchema,
 * no transforms): a non-object schema would make LangChain's `tool()` build
 * a string-input DynamicTool, silently violating the Concierge invoke
 * contract. `createConciergeTools` enforces this; direct callers own it.
 */
export function toLangChainTool(t: ConciergeTool): StructuredToolInterface {
  return lcTool(async (args) => bigintSafeStringify(await t.invoke(args)), {
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
