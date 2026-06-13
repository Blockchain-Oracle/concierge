#!/usr/bin/env node
// stdio entry per ADR-011 amended — DEFAULT install path
// (`claude mcp add concierge -- npx -y @concierge/mcp`). Stdout is RESERVED
// for MCP JSON-RPC traffic; ALL logs MUST go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConciergeMcpServer } from './server.ts';

/**
 * Tools are provided lazily so consumers (or downstream tests) can pass their
 * own factory. The default bin entry resolves to an empty toolset — story-130
 * scaffolds the transport core; the production toolset wires through in a
 * follow-up (the @concierge/agent integration story).
 *
 * To run with a real toolset, import this module and pass a non-empty tools
 * array via `runStdio({ tools })`.
 */
export async function runStdio(
  opts: {
    readonly tools?: ReadonlyArray<Parameters<typeof createConciergeMcpServer>[0]['tools'][number]>;
  } = {},
): Promise<void> {
  const tools = opts.tools ?? [];
  const server = createConciergeMcpServer({ tools });
  const transport = new StdioServerTransport();
  // The connect() call resolves after the transport closes (process kill /
  // peer disconnect). Until then this Promise stays pending, keeping the
  // event loop alive.
  await server.connect(transport);
}

// Auto-run when invoked as a binary (CommonJS-style entrypoint check via
// import.meta.url comparing to argv[1]). Skip when imported by tests or by
// the streamable-http wrapper.
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runStdio().catch((err) => {
    process.stderr.write(
      `[concierge-mcp] stdio entry failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
