// Vercel AI SDK v6 adapter for the framework-agnostic @concierge/tools registry
// (ADR-014). `outputSchema` passthrough is load-bearing: it powers InferUITools
// typing on `tool-${name}` UI parts and MCP structuredContent (ADR-017).

import {
  type ConciergeAgentLike,
  type ConciergeTool,
  createConciergeTools,
  type ProviderToolFactory,
} from '@concierge/tools';
import { tool as aiTool, type Tool, type ToolSet } from 'ai';
import type { z } from 'zod';

/**
 * Convert one ConciergeTool into a Vercel AI SDK v6 tool, preserving the
 * per-tool generics so `InferToolInput` / `InferToolOutput` (and therefore
 * `InferUITools`) recover the exact `z.infer<…>` types. The registry erases
 * generics at its boundary, so callers needing precise inference should
 * convert concretely-typed tool definitions with this function directly.
 */
export function toVercelAITool<
  TIn extends z.ZodTypeAny,
  // biome-ignore lint/suspicious/noExplicitAny: matches the ConciergeTool ZodObject<any> generic
  TOut extends z.ZodObject<any>,
>(t: ConciergeTool<TIn, TOut>): Tool<z.infer<TIn>, z.infer<TOut>>;
// Overload split: inside a generic body, tool()'s schema-driven inference
// resolves against the type parameters' CONSTRAINTS — INPUT collapses to
// `unknown` and OUTPUT to `Record<string, unknown>` (z.infer of
// ZodObject<any>) — and its `NeverOptional<…>` conditional cannot be
// structurally checked against unresolved type parameters. The loose
// implementation signature sidesteps both while the public overload keeps
// per-tool inference exact.
export function toVercelAITool(t: ConciergeTool): Tool {
  return aiTool({
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    execute: (args) => t.invoke(args),
  });
}

/**
 * Build a `streamText({ tools })`-ready ToolSet from the Concierge registry.
 * Mirrors `createConciergeTools(agent, providerToolFactories)`: omitting the
 * factories yields an empty ToolSet, and registry validation errors
 * (duplicate names, schema violations) propagate unchanged.
 *
 * Aborting `streamText` does NOT cancel an in-flight tool call —
 * `ConciergeTool.invoke` takes no abort signal, so a started execution
 * (e.g. an on-chain transaction) runs to completion.
 */
export function getVercelAITools(
  agent: ConciergeAgentLike,
  providerToolFactories?: ReadonlyArray<ProviderToolFactory>,
): ToolSet {
  return Object.fromEntries(
    createConciergeTools(agent, providerToolFactories).map((t) => [t.name, toVercelAITool(t)]),
  );
}
