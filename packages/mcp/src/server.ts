import { bigintSafeStringify, type ConciergeTool } from '@concierge/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

const SERVER_INFO = { name: 'concierge-mcp', version: '0.0.0' } as const;

export interface CreateConciergeMcpServerOpts {
  /**
   * Tools to expose via MCP. Each tool's `inputSchema` / `outputSchema` flow
   * straight into `server.registerTool(...)` — `outputSchema` is MANDATORY per
   * ADR-014/017 (drives MCP `structuredContent` + `@concierge/react-ui`
   * parse-then-render). All `@concierge/tools` already enforce this.
   */
  readonly tools: ReadonlyArray<ConciergeTool>;
  /** Optional server info override (name + version) for non-default builds. */
  readonly info?: { readonly name: string; readonly version: string };
}

/**
 * Transport-agnostic MCP server factory per ADR-011 amendment (stdio-first +
 * optional Cloudflare Worker). Stdio + streamable-http wrappers both consume
 * this factory; the only thing that changes is the transport adapter.
 *
 * Each `ConciergeTool` is registered with both `inputSchema` and `outputSchema`
 * exposed as raw Zod shapes (the SDK's expected form). The handler invokes the
 * tool and returns BOTH `content` (textual fallback for MCP clients that don't
 * read `structuredContent`) AND `structuredContent` (the typed object).
 *
 * On tool error, returns a JSON-RPC error result with `isError: true` and a
 * sanitized message — does NOT crash the server.
 */
export function createConciergeMcpServer(opts: CreateConciergeMcpServerOpts): McpServer {
  const info = opts.info ?? SERVER_INFO;
  const server = new McpServer(info);

  for (const tool of opts.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: getShape(tool.inputSchema),
        outputSchema: getShape(tool.outputSchema),
      },
      async (args: unknown) => {
        try {
          const result = await tool.invoke(args as never);
          const text = bigintSafeStringify(result);
          return {
            content: [{ type: 'text', text }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          const message = err instanceof Error ? sanitize(err.message) : 'tool execution failed';
          return {
            content: [{ type: 'text', text: `Tool '${tool.name}' failed: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

/** Return the Zod object `.shape` — what `registerTool` expects for both schemas. */
function getShape(schema: unknown): z.ZodRawShape {
  const shape = (schema as { shape?: unknown }).shape;
  if (shape === undefined || shape === null || typeof shape !== 'object') {
    throw new Error(
      '[@concierge/mcp] inputSchema/outputSchema must be a z.ZodObject (shape is required for MCP registerTool).',
    );
  }
  return shape as z.ZodRawShape;
}

function sanitize(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CWE-117 mitigation
  return s.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 512);
}
