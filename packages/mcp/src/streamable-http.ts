// Streamable-HTTP handler for the OPTIONAL Cloudflare Worker variant per
// ADR-011 amended. story-133 consumes this from `apps/mcp/`. Stdio remains
// the DEFAULT install path.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type CreateConciergeMcpServerOpts, createConciergeMcpServer } from './server.ts';

export interface StreamableHttpHandlerOpts extends CreateConciergeMcpServerOpts {
  /**
   * Session id generator. The MCP SDK expects a deterministic generator per
   * `Mcp-Session-Id` header so the Worker can route streaming responses.
   * Defaults to `crypto.randomUUID()` which is available on Workers + Node 19+.
   */
  readonly sessionIdGenerator?: () => string;
}

/**
 * Returns an MCP server bound to a Streamable-HTTP transport. The Worker
 * wrapper (story-133) is responsible for adapting Cloudflare's Request/Response
 * to the transport — this factory keeps the server-creation seam testable
 * without pulling Cloudflare's runtime.
 */
export function createStreamableHttpHandler(opts: StreamableHttpHandlerOpts): {
  readonly server: ReturnType<typeof createConciergeMcpServer>;
  readonly transport: StreamableHTTPServerTransport;
} {
  const server = createConciergeMcpServer({
    tools: opts.tools,
    ...(opts.info !== undefined ? { info: opts.info } : {}),
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: opts.sessionIdGenerator ?? (() => globalThis.crypto.randomUUID()),
  });
  return { server, transport };
}
