import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stdio.ts', 'src/streamable-http.ts'],
  format: ['esm'],
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  target: 'node22',
  tsconfig: 'tsconfig.build.json',
  // The #!/usr/bin/env node shebang is preserved by tsup from stdio.ts source.
  external: [
    'zod',
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/server/mcp.js',
    '@modelcontextprotocol/sdk/server/stdio.js',
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
    '@concierge/shared',
    '@concierge/tools',
  ],
});
