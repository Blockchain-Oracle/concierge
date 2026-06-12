import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['src/__tests__/**/*.test.ts'],
  },
});
