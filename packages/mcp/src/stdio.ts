#!/usr/bin/env node
// stdio entry per ADR-011 amended — DEFAULT install path
// (`claude mcp add concierge -- npx -y @concierge/mcp`). Stdout is RESERVED
// for MCP JSON-RPC; ALL logs MUST go to stderr.

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type CreateConciergeMcpServerOpts, createConciergeMcpServer } from './server.ts';

/**
 * Tools are provided lazily so consumers (or downstream tests) can pass their
 * own factory. The default bin entry resolves to an empty toolset — story-130
 * scaffolds the transport core; the production toolset wires through in a
 * follow-up agent integration story.
 *
 * Round-1: emit a loud stderr warning when called with an empty toolset so
 * users running `npx -y @concierge/mcp` see why Claude Desktop shows "0 tools"
 * — silent no-op would route bug reports to the wrong layer.
 */
export async function runStdio(
  opts: { readonly tools?: CreateConciergeMcpServerOpts['tools'] } = {},
): Promise<void> {
  const tools = opts.tools ?? [];
  if (tools.length === 0) {
    process.stderr.write(
      '[concierge-mcp] WARNING: starting with 0 tools registered. ' +
        'The transport core is functional but no tools are wired. ' +
        'See the @concierge/agent integration story for the production toolset.\n',
    );
  }
  const server = createConciergeMcpServer({ tools });
  const transport = new StdioServerTransport();
  // connect() resolves after transport close (process kill / peer disconnect).
  // Until then the Promise stays pending, keeping the event loop alive.
  await server.connect(transport);
}

/**
 * Round-1 (silent-failure HIGH): detect bin invocation under symlinks/Windows.
 * `npx -y @concierge/mcp` installs via a symlinked shim; argv[1] is the
 * symlink, `import.meta.url` is the resolved real path — string-equal fails.
 * `realpathSync` both sides + canonical `pathToFileURL` comparison handles
 * symlinks, Windows path encoding, and node `--import` invocations.
 */
function isInvokedAsBin(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    const realArgv = realpathSync(process.argv[1]);
    const realModule = realpathSync(fileURLToPath(import.meta.url));
    if (realArgv === realModule) return true;
    return pathToFileURL(realArgv).href === pathToFileURL(realModule).href;
  } catch {
    return false;
  }
}

if (isInvokedAsBin()) {
  runStdio().catch((err) => {
    process.stderr.write(
      `[concierge-mcp] stdio entry failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
