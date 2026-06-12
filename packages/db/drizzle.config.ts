import { defineConfig } from 'drizzle-kit';

// biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error(
    '[@concierge/db] drizzle.config.ts: DATABASE_URL is required. Set it before running drizzle-kit (e.g. DATABASE_URL=postgresql://localhost:5432/concierge_dev pnpm db:generate).',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
