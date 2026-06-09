// Convert a tool's schemas to OpenAPI 3 JSON Schema for OpenAI / Anthropic / MCP.
// Refinements (.refine, .superRefine) are stripped silently — JSON Schema can't
// represent them. Prefer expressible constraints (.regex, .min, .max, .email)
// at tool boundaries; refinements re-check at runtime via parse(), not advertised.

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
