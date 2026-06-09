// Convert a tool's schemas to OpenAPI 3 JSON Schema for OpenAI / Anthropic / MCP.
// Behavior on non-representable shapes:
//  - Refinements (.refine, .superRefine) are stripped silently.
//  - .transform() throws at conversion time (shape changes, no safe round-trip).
//  - z.custom() emits trivial `{}` (no constraints) — adapter sends a schema-less
//    field to the LLM.
//  - .pipe() may convert as the first segment or throw — adapter should validate.
// Wrapper re-throws with tool name + field (inputSchema vs outputSchema) for
// attribution; original Zod throw preserved as `cause`. ADR-017 outputSchema-
// must-be-ZodObject is enforced upstream in createConciergeTools.

import { z } from 'zod';
import type { ConciergeTool } from './types.ts';

function convert(
  schema: z.ZodTypeAny,
  toolName: string,
  field: 'inputSchema' | 'outputSchema',
): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `[@concierge/tools] toJsonSchema: cannot convert ${field} for tool "${toolName}" — ${
        cause instanceof Error ? cause.message : String(cause)
      }. .transform() / z.custom() / .pipe() are not representable in JSON Schema.`,
      { cause },
    );
  }
}

export function toInputJsonSchema(tool: ConciergeTool): Record<string, unknown> {
  return convert(tool.inputSchema, tool.name, 'inputSchema');
}

export function toOutputJsonSchema(tool: ConciergeTool): Record<string, unknown> {
  return convert(tool.outputSchema, tool.name, 'outputSchema');
}

/** Canonical name per ADR-014 — alias of `toInputJsonSchema` for the common single-schema case. */
export const toJsonSchema = toInputJsonSchema;
