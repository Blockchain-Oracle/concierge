// Raw-shape OpenAI adapter for the framework-agnostic @concierge/tools
// registry (ADR-014). Wraps NO SDK — emits the Chat Completions wire-format
// tool array plus a dispatch() executor, so the same toolkit drives the
// `openai` client AND Anthropic Messages raw tool-use (key renames only:
// { name, description, input_schema: parameters }). Wrapper SDKs like
// @openai/agents are banned as stale per AUDIT-2026-06-09 §7; the `openai`
// and `@anthropic-ai/sdk` packages appear only as type-only devDependencies
// that pin wire-shape compatibility in tests.

import {
  bigintSafeStringify,
  type ConciergeAgentLike,
  type ConciergeTool,
  createConciergeTools,
  isZodObject,
  isZodPipe,
  type ProviderToolFactory,
  toJsonSchema,
} from '@concierge/tools';

/**
 * Duck-typed per the guards.ts convention: `instanceof z.ZodError` fails
 * across realm boundaries when a consumer's graph resolves a second zod
 * copy, and would silently skip attribution. Also keeps this adapter free
 * of runtime zod imports (type-only siblings posture).
 */
function isZodError(err: unknown): err is Error & { issues: unknown[] } {
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * Re-exported for callers building the tool-result message: dispatch returns
 * the raw invoke() value, and both wire formats want a string
 * (`{ role: 'tool', content }` / `{ type: 'tool_result', content }`).
 * Plain JSON.stringify throws on the wei-scale bigints Concierge tools emit;
 * this serializer rewrites them to decimal strings.
 */
export { bigintSafeStringify };

/**
 * The function definition inside the tool envelope. `parameters` carries the
 * literal `type: 'object'` invariant in the type itself, so it is directly
 * assignable to BOTH the `openai` SDK's `FunctionParameters` AND Anthropic's
 * `Tool['input_schema']` (which requires the literal) — the dual-runtime
 * claim is type-enforced, not cast-assisted.
 */
export interface OpenAIFunctionDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; [key: string]: unknown };
}

/**
 * The NESTED Chat Completions function-tool wire shape (`.function` holds the
 * definition). Structurally assignable to the `openai` SDK's
 * `ChatCompletionFunctionTool` — pinned by a type-level test. The flat
 * Responses-API `FunctionTool` shape is NOT this type.
 */
export interface OpenAIFunctionTool {
  type: 'function';
  function: OpenAIFunctionDefinition;
}

/**
 * `tools` goes into the request body; `dispatch` executes a model-issued
 * tool call. `args` accepts the raw JSON string from a Chat Completions
 * `tool_calls[].function.arguments` or the already-parsed object from an
 * Anthropic `tool_use.input` block (`object` rather than
 * `Record<string, unknown>` because interface-typed arg objects lack an
 * implicit index signature — the wider type costs nothing: junk values are
 * rejected loudly by `inputSchema.parse`).
 *
 * Treat `tools` as readonly: it is a snapshot sharing one registry build with
 * `dispatch`, so mutating the array does NOT change what `dispatch` will
 * execute — subset at the `providerToolFactories` level instead. (The array
 * stays mutable only because the `openai` SDK's request type wants
 * `Array<ChatCompletionTool>`.)
 */
export interface OpenAIToolkit {
  tools: OpenAIFunctionTool[];
  dispatch(name: string, args: string | object): Promise<unknown>;
}

/**
 * Convert one ConciergeTool into the Chat Completions function-tool shape,
 * with `parameters` emitted as OpenAPI-3 JSON Schema via `toJsonSchema`.
 *
 * Throws a `TypeError` when `inputSchema` is not a plain Zod object — the
 * registry invariant `createConciergeTools` already enforces, re-checked here
 * because direct callers bypass the registry. Pipes get their own error:
 * `z.toJSONSchema` throws on `.transform()` chains, but silently converts a
 * plain `.pipe()` as its OUTPUT (last) segment — advertising what `parse()`
 * *returns* rather than what it *accepts*, so the model would send arguments
 * that fail validation at dispatch time.
 *
 * Note: emitted schemas carry `additionalProperties: false`, but `.optional()`
 * properties are omitted from `required`, so they are not OpenAI strict-mode
 * ready in general (`strict: true` wants every property required); see the
 * README if you need strict mode.
 */
export function toOpenAITool(t: ConciergeTool): OpenAIFunctionTool {
  if (isZodPipe(t.inputSchema)) {
    throw new TypeError(
      `Tool "${t.name}" inputSchema uses .transform() or .pipe(); perform normalization inside invoke() instead — the schema advertised to the model must match what inputSchema.parse() accepts.`,
    );
  }
  if (!isZodObject(t.inputSchema)) {
    throw new TypeError(
      `Tool "${t.name}" has a non-object inputSchema; ConciergeTool requires a Zod object schema (z.object({ ... })).`,
    );
  }
  const parameters = toJsonSchema(t);
  // The isZodObject guard makes a root `type: 'object'` certain today, but
  // that rests on z.toJSONSchema's emission behavior — guard loudly instead
  // of stamping the literal over a malformed root if a zod bump changes it.
  // The spread below re-asserts the literal only to satisfy TypeScript's
  // `type: 'object'` field; this guard guarantees it is a runtime no-op.
  if (parameters['type'] !== 'object') {
    throw new TypeError(
      `[@concierge/openai] toOpenAITool: expected a root type:"object" schema for tool "${t.name}", got ${JSON.stringify(parameters['type'])} — z.toJSONSchema emission may have changed; pin/check the zod version.`,
    );
  }
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: { ...parameters, type: 'object' },
    },
  };
}

/**
 * Build a Chat Completions toolkit from the Concierge registry. Mirrors
 * `createConciergeTools(agent, providerToolFactories)`: omitting the
 * factories yields an empty `tools` array (an unsupported `chainId` does the
 * same — if the model never sees your tools, check both), and registry
 * validation errors (duplicate names, schema violations) propagate unchanged.
 *
 * `dispatch` parses string args as JSON (malformed JSON re-raises as a
 * tool-attributed `SyntaxError`, original error as `cause`), rejects unknown
 * tool names loudly, and validates with the tool's own `inputSchema`
 * BEFORE invoking — `invoke` always receives the PARSED value (defaults
 * applied, unknown keys stripped), the same invariant every other Concierge
 * adapter upholds. No framework sits in between here, so the adapter is the
 * one that must parse. `outputSchema` is deliberately NOT enforced on the
 * return value (same policy as the langchain sibling): Chat Completions has
 * no return-shape slot, and dispatch hands back the raw `invoke()` result —
 * output validation belongs to the tool.
 *
 * Cancelling a model run does NOT cancel an in-flight tool call —
 * `ConciergeTool.invoke` takes no abort signal, so a started execution
 * (e.g. an on-chain transaction) runs to completion.
 */
export function getOpenAITools(
  agent: ConciergeAgentLike,
  providerToolFactories?: ReadonlyArray<ProviderToolFactory>,
): OpenAIToolkit {
  const conciergeTools = createConciergeTools(agent, providerToolFactories);
  const tools = conciergeTools.map(toOpenAITool);
  const byName = new Map(conciergeTools.map((t) => [t.name, t]));
  return {
    tools,
    async dispatch(name, args) {
      const t = byName.get(name);
      if (!t) {
        const known = [...byName.keys()].sort();
        throw new Error(
          `[@concierge/openai] dispatch: unknown tool "${name}". ${
            known.length === 0
              ? 'No tools are registered — check providerToolFactories and agent.chainId.'
              : `Known tools: ${known.join(', ')}`
          }`,
        );
      }
      let parsed: unknown;
      if (typeof args === 'string') {
        try {
          parsed = JSON.parse(args);
        } catch (cause) {
          // Re-raise as SyntaxError (the documented contract) but with tool
          // attribution — in a Promise.all fan-out over parallel tool calls,
          // a bare "Unexpected token" names neither tool nor payload.
          throw new SyntaxError(
            `[@concierge/openai] dispatch("${name}"): malformed JSON arguments — ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          );
        }
      } else {
        parsed = args;
      }
      let input: unknown;
      try {
        input = t.inputSchema.parse(parsed);
      } catch (err) {
        // Same-instance message rewrite: keeps the documented `instanceof
        // ZodError` contract while giving the rejection the same tool
        // attribution the SyntaxError path has — a bare "expected string at
        // goal" names no tool in a parallel-call fan-out. Best-effort: parse
        // throws a FRESH error each call (no double-prefix), `message` is a
        // writable own property on zod 4.4.3, and if a future zod makes it
        // getter-only the attribution is skipped rather than replacing the
        // ZodError with a TypeError mid-flight.
        if (isZodError(err)) {
          try {
            err.message = `[@concierge/openai] dispatch("${name}"): arguments failed inputSchema validation — ${err.message}`;
          } catch {
            // attribution only — the original error still propagates below
          }
        }
        throw err;
      }
      return t.invoke(input);
    },
  };
}
