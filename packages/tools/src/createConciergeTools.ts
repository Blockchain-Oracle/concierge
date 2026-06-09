// Aggregate ConciergeTools from provider factories + chain-gate filter.
// Per-tool generics intentionally erased; adapters dispatch by name at runtime.

import type { z } from 'zod';
import type { ConciergeAgentLike, ConciergeTool, ProviderToolFactory } from './types.ts';

export function createConciergeTools(
  agent: ConciergeAgentLike,
  providerToolFactories: ReadonlyArray<ProviderToolFactory> = [],
): ReadonlyArray<ConciergeTool> {
  const out: ConciergeTool[] = [];
  const seen = new Map<string, number>();

  providerToolFactories.forEach((factory, idx) => {
    let produced: ReturnType<ProviderToolFactory>;
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
    if (!Array.isArray(produced)) {
      throw new TypeError(
        `[@concierge/tools] factory at index ${idx} returned ${typeof produced}, expected ConciergeTool[]`,
      );
    }

    for (const t of produced) {
      if (
        t === null ||
        typeof t !== 'object' ||
        typeof t.name !== 'string' ||
        t.name.length === 0 ||
        typeof t.description !== 'string' ||
        typeof t.invoke !== 'function' ||
        t.inputSchema === undefined ||
        t.outputSchema === undefined
      ) {
        throw new TypeError(
          `[@concierge/tools] factory at index ${idx} produced an invalid tool (missing/invalid name|description|inputSchema|outputSchema|invoke); got name=${JSON.stringify(t?.name)}`,
        );
      }

      if (t.supportsNetwork !== undefined) {
        const verdict = t.supportsNetwork(agent.chainId);
        if (typeof verdict !== 'boolean') {
          throw new TypeError(
            `[@concierge/tools] ${t.name}.supportsNetwork must return boolean, got ${typeof verdict}`,
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
