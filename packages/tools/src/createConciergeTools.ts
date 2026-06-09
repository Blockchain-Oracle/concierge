// Aggregate ConciergeTools from provider factories. Performs ten duties:
// (1) wraps factory(agent) sync throws with factory-index attribution + cause;
// (2) detects Promise/thenable returns (factories must be synchronous);
// (3) rejects non-array factory returns (with a thenable-without-.catch hint);
// (4) validates tool shape (name/description/invoke must be present + right types);
// (5) duck-types inputSchema + outputSchema as actual Zod schemas via _def.type;
// (6) rejects .transform()/.pipe() on BOTH inputSchema and outputSchema (not
//     representable in JSON Schema; normalize inside invoke() instead);
// (7) enforces inputSchema AND outputSchema are ZodObject (MCP tool-calls
//     pass args + return structuredContent as objects);
// (8) chain-gates each tool via supportsNetwork (type-checks fn + boolean return,
//     and isolates supportsNetwork throws so one buggy gate doesn't kill the
//     whole registry);
// (9) dedups names with factory-index attribution on collision;
// (10) returns an immutable ReadonlyArray for adapter consumption.
// invoke() errors are NOT wrapped here — each adapter (Vercel AI / OpenAI /
// MCP / AgentKit) owns its own invoke error envelope per ADR-014.
// Per-tool generics intentionally erased; adapters dispatch by name at runtime.

import { isThenable, isZodObject, isZodPipe, isZodSchema } from './guards.ts';
import type { ConciergeAgentLike, ConciergeTool, ProviderToolFactory } from './types.ts';

export function createConciergeTools(
  agent: ConciergeAgentLike,
  providerToolFactories: ReadonlyArray<ProviderToolFactory> = [],
): ReadonlyArray<ConciergeTool> {
  const out: ConciergeTool[] = [];
  const seen = new Map<string, number>();

  providerToolFactories.forEach((factory, idx) => {
    let produced: unknown;
    try {
      produced = factory(agent);
    } catch (cause) {
      throw new Error(
        `[@concierge/tools] factory at index ${idx} threw during construction: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
    if (isThenable(produced)) {
      // Suppress the secondary unhandledRejection so users see only OUR error.
      (produced as Promise<unknown>).catch(() => {});
      throw new TypeError(
        `[@concierge/tools] factory at index ${idx} returned a Promise. ProviderToolFactory must be synchronous; await any async setup before calling createConciergeTools.`,
      );
    }
    if (!Array.isArray(produced)) {
      // Fallback diagnostic: a `.then`-only thenable (Promises/A+ §1.2 spec
      // compliant but missing `.catch`) slips past `isThenable`. Surface
      // the hint so the user doesn't chase a confusing "expected array".
      const maybeThen =
        produced !== null &&
        typeof produced === 'object' &&
        typeof (produced as { then?: unknown }).then === 'function';
      const hint = maybeThen ? ' (looks like a thenable — did you forget to await?)' : '';
      throw new TypeError(
        `[@concierge/tools] factory at index ${idx} returned ${typeof produced}, expected ConciergeTool[]${hint}`,
      );
    }

    for (const t of produced as ConciergeTool[]) {
      if (
        t === null ||
        typeof t !== 'object' ||
        typeof t.name !== 'string' ||
        t.name.length === 0 ||
        typeof t.description !== 'string' ||
        typeof t.invoke !== 'function'
      ) {
        throw new TypeError(
          `[@concierge/tools] factory at index ${idx} produced an invalid tool (missing/invalid name|description|invoke); got name=${JSON.stringify(t?.name)}`,
        );
      }
      if (!isZodSchema(t.inputSchema) || !isZodSchema(t.outputSchema)) {
        throw new TypeError(
          `[@concierge/tools] tool "${t.name}" inputSchema/outputSchema must be Zod schemas (got input=${typeof t.inputSchema}, output=${typeof t.outputSchema})`,
        );
      }
      // Symmetric pipe check on inputSchema — MCP tool-call args are passed as
      // an object; .transform()/.pipe() inputSchemas would fail JSON Schema
      // conversion later in the adapter layer with worse attribution.
      if (isZodPipe(t.inputSchema)) {
        throw new TypeError(
          `[@concierge/tools] tool "${t.name}".inputSchema uses .transform() or .pipe() — cannot be represented in JSON Schema (perform normalization inside invoke() instead of in the schema).`,
        );
      }
      if (isZodPipe(t.outputSchema)) {
        throw new TypeError(
          `[@concierge/tools] tool "${t.name}".outputSchema uses .transform() or .pipe() — cannot be represented in JSON Schema (perform normalization inside invoke() instead of in the schema).`,
        );
      }
      // MCP tool-call args MUST be an object too (asymmetric with outputSchema
      // only in spec emphasis; the ADR doesn't carve out scalar inputs).
      if (!isZodObject(t.inputSchema)) {
        throw new TypeError(
          `[@concierge/tools] tool "${t.name}".inputSchema must be a z.ZodObject (MCP / Vercel AI / OpenAI tool-calls pass args as an object); wrap scalar inputs in z.object({ value: ... })`,
        );
      }
      if (!isZodObject(t.outputSchema)) {
        throw new TypeError(
          `[@concierge/tools] tool "${t.name}".outputSchema must be a z.ZodObject per ADR-017 (MCP structuredContent requires top-level object); wrap scalar returns in z.object({ value: ... })`,
        );
      }
      if (t.supportsNetwork !== undefined) {
        if (typeof t.supportsNetwork !== 'function') {
          throw new TypeError(
            `[@concierge/tools] tool "${t.name}".supportsNetwork must be a function, got ${typeof t.supportsNetwork}`,
          );
        }
        let verdict: unknown;
        try {
          verdict = t.supportsNetwork(agent.chainId);
        } catch (cause) {
          // Isolate: one buggy supportsNetwork shouldn't take down the whole registry.
          throw new Error(
            `[@concierge/tools] tool "${t.name}".supportsNetwork threw: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          );
        }
        if (typeof verdict !== 'boolean') {
          throw new TypeError(
            `[@concierge/tools] tool "${t.name}".supportsNetwork must return boolean, got ${typeof verdict}`,
          );
        }
        if (!verdict) continue;
      }

      const prior = seen.get(t.name);
      if (prior !== undefined) {
        throw new Error(
          `[@concierge/tools] duplicate tool name "${t.name}" — registered by factory ${prior} and factory ${idx}`,
        );
      }
      seen.set(t.name, idx);
      out.push(t);
    }
  });

  return out;
}
