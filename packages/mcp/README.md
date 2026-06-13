# @concierge/mcp

Transport-agnostic MCP server for Concierge, per ADR-011 amended.

- **Default install path**: stdio bin. `claude mcp add concierge -- npx -y @concierge/mcp`
- **Optional hosted variant**: Cloudflare Worker wrapping `createStreamableHttpHandler`. Lives in `apps/mcp/` (story-133).

## Why two entry points

Stdio is the lowest-friction install for Claude Desktop and other MCP clients
that spawn the server as a child process. The hosted streamable-HTTP variant
covers clients that need a public endpoint (`https://mcp.concierge.xyz/mcp`).
Both consume the same `createConciergeMcpServer({ tools })` factory so they
expose identical behavior.

## Stdio bin contract

- Stdout is RESERVED for MCP JSON-RPC. ALL logs go to stderr.
- Tools registered via `createConciergeMcpServer` MUST have `outputSchema`
  (ADR-014 / 017 — drives MCP `structuredContent` + React UI parse-then-render).
- Tool errors surface as JSON-RPC results with `isError: true` and a
  CWE-117-sanitized message; the server does NOT crash on tool failure.

## Quickstart

```ts
import { createConciergeMcpServer } from '@concierge/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createConciergeMcpServer({ tools: /* @concierge/tools */ [] });
await server.connect(new StdioServerTransport());
```
