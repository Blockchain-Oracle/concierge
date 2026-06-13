// Streamable-HTTP handler for the OPTIONAL Cloudflare Worker variant per
// ADR-011 amended. story-133 consumes this from `apps/mcp/`. Stdio remains
// the DEFAULT install path.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type CreateConciergeMcpServerOpts, createConciergeMcpServer } from './server.ts';

export interface StreamableHttpHandlerOpts extends CreateConciergeMcpServerOpts {
  /**
   * Session id generator. The MCP SDK expects a deterministic generator per
   * `Mcp-Session-Id` header so the Worker can route streaming responses.
   *
   * **Security (CWE-330):** the generator MUST produce cryptographically
   * random IDs. A predictable generator allows session hijack on the hosted
   * variant. The default uses `globalThis.crypto.randomUUID` (UUID v4, 122
   * bits of entropy). Overrides should reuse the same primitive.
   */
  readonly sessionIdGenerator?: () => string;
}

/**
 * Returns an MCP server bound to a Streamable-HTTP transport. The Worker
 * wrapper (story-133) is responsible for adapting Cloudflare's Request/Response
 * to the transport — this factory keeps the server-creation seam testable
 * without pulling Cloudflare's runtime.
 *
 * Round-1: fail loud if the runtime lacks `crypto.randomUUID` AND no override
 * is provided. Node ≥ 22 (ADR-018) always has it, but hostile sandboxes /
 * stripped-down Workers may not.
 */
export function createStreamableHttpHandler(opts: StreamableHttpHandlerOpts): {
  readonly server: ReturnType<typeof createConciergeMcpServer>;
  readonly transport: StreamableHTTPServerTransport;
} {
  const sessionIdGenerator = opts.sessionIdGenerator ?? defaultSessionIdGenerator();
  const server = createConciergeMcpServer({
    tools: opts.tools,
    ...(opts.info !== undefined ? { info: opts.info } : {}),
    ...(opts.onToolError !== undefined ? { onToolError: opts.onToolError } : {}),
    ...(opts.onEmptyToolset !== undefined ? { onEmptyToolset: opts.onEmptyToolset } : {}),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });
  return { server, transport };
}

function defaultSessionIdGenerator(): () => string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined || typeof cryptoApi.randomUUID !== 'function') {
    throw new Error(
      '[@concierge/mcp] runtime lacks `globalThis.crypto.randomUUID` — pass `sessionIdGenerator` explicitly (must be cryptographically random; CWE-330).',
    );
  }
  return () => cryptoApi.randomUUID();
}
