import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stdio.ts', 'src/streamable-http.ts'],
  format: ['esm'],
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  target: 'node22',
  tsconfig: 'tsconfig.build.json',
  // stdio.ts needs a shebang so `npx -y @concierge/mcp` runs it as a script.
  banner: ({ format }) => {
    return format === 'esm' ? { js: '' } : {};
  },
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
