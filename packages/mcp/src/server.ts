import { bigintSafeStringify, type ConciergeTool } from '@concierge/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const SERVER_INFO = { name: 'concierge-mcp', version: '0.0.0' } as const;
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface CreateConciergeMcpServerOpts {
  /**
   * Tools to expose via MCP. Each tool's `inputSchema` / `outputSchema` flow
   * straight into `server.registerTool(...)` — `outputSchema` is MANDATORY per
   * ADR-014/017 (drives MCP `structuredContent` + `@concierge/react-ui`
   * parse-then-render).
   */
  readonly tools: ReadonlyArray<ConciergeTool>;
  readonly info?: { readonly name: string; readonly version: string };
  /**
   * Optional logger for tool-failure observability. Defaults to stderr so the
   * stdio bin keeps stdout reserved for MCP JSON-RPC. Override in tests +
   * worker context for structured logging.
   */
  readonly onToolError?: (info: { readonly toolName: string; readonly error: unknown }) => void;
}

/**
 * Transport-agnostic MCP server factory per ADR-011 amendment. Stdio +
 * streamable-http wrappers both consume this factory; only the transport
 * adapter changes.
 *
 * Each `ConciergeTool` is registered with its `inputSchema` (re-parsed inside
 * the handler so schema mismatches surface as a typed MCP error rather than a
 * crash) and `outputSchema` (exposed for MCP `structuredContent`). Tool
 * failures return `isError: true` + sanitized message AND emit an observable
 * log so ops sees which tools are failing in production.
 */
export function createConciergeMcpServer(opts: CreateConciergeMcpServerOpts): McpServer {
  const info = opts.info ?? SERVER_INFO;
  const onToolError = opts.onToolError ?? defaultOnToolError;
  const server = new McpServer(info);

  for (const tool of opts.tools) {
    const inputObject = assertZodObject(tool.inputSchema, tool.name, 'inputSchema');
    const outputObject = assertZodObject(tool.outputSchema, tool.name, 'outputSchema');

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputObject.shape,
        outputSchema: outputObject.shape,
      },
      async (args: unknown) => {
        try {
          // The SDK pre-validates `args` against the registered zod schema
          // (shape + refinements) BEFORE this handler runs — invalid inputs
          // surface to the client as -32602 Invalid params and never reach
          // here. So no re-parse needed; trust the SDK contract.
          const rawResult = await tool.invoke(args as never);
          const result = scrubPrototypePollution(rawResult);
          const text = sanitize(bigintSafeStringify(result));
          return {
            content: [{ type: 'text', text }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          onToolError({ toolName: tool.name, error: err });
          const message = err instanceof Error ? sanitize(err.message) : 'tool execution failed';
          return {
            content: [{ type: 'text', text: `Tool '${tool.name}' failed: ${message}` }],
            // Round-1 (test gap 8/10): explicitly omit structuredContent on
            // error to prevent partial-data leakage on the failure path.
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

function assertZodObject(
  schema: z.ZodTypeAny,
  toolName: string,
  field: 'inputSchema' | 'outputSchema',
): z.ZodObject<z.ZodRawShape> {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `[@concierge/mcp] tool '${toolName}' ${field} must be a z.ZodObject (MCP registerTool requires shape).`,
    );
  }
  return schema as z.ZodObject<z.ZodRawShape>;
}

/**
 * Round-1 CWE-1321: drop prototype-pollution keys from tool outputs. Required
 * because @concierge tools using `z.record()` / `z.passthrough()` (Li.Fi
 * quotes, DEX payloads) don't strip unknown keys via Zod alone — the upstream
 * JSON containing `__proto__` / `constructor.prototype` would otherwise flow
 * through `structuredContent` to MCP clients that deep-merge.
 *
 * One-pass JSON round-trip with a reviver — cheap on the typical sub-100KB
 * payload size; strings/bigints preserved via bigintSafeStringify downstream.
 */
function scrubPrototypePollution<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return walk(value) as T;
}

function walk(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walk);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (PROTO_POLLUTION_KEYS.has(k)) continue;
    out[k] = walk(v);
  }
  return out;
}

/** Round-1 CWE-400: slice BEFORE strip so the regex scan is O(min(n, 512)). */
function sanitize(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: CWE-117 mitigation
  return s.slice(0, 512).replace(/[\u0000-\u001f\u007f]/g, '?');
}

function defaultOnToolError(info: { readonly toolName: string; readonly error: unknown }): void {
  const errLine =
    info.error instanceof Error
      ? `${info.error.name}: ${info.error.message}\n${info.error.stack ?? ''}`
      : String(info.error);
  process.stderr.write(`[concierge-mcp] tool '${info.toolName}' failed: ${errLine}\n`);
}
