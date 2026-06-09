import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/serializable.ts'],
  format: ['esm'],
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  target: 'node22',
  tsconfig: 'tsconfig.build.json',
  external: ['zod', '@concierge/shared'],
});
