import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.ts';

export type DbClient = NodePgDatabase<typeof schema>;

export interface CreateDbClientOptions {
  /**
   * If true, runs a `SELECT 1` before returning to surface connection problems
   * (bad URL, wrong SSL mode, missing password) at startup instead of lazily on
   * the first query — which would otherwise happen mid-tick in the worker.
   */
  readonly ping?: boolean;
  /**
   * Optional error logger invoked when the Pool emits `'error'` (idle-client
   * disconnect, PG restart, PgBouncer kill). Without this, Node's default
   * crashes the process on the unhandled 'error' event.
   */
  readonly onPoolError?: (err: Error) => void;
}

/**
 * Creates a Drizzle client backed by a node-postgres connection pool. The
 * returned `pool` is exposed so consumers (worker, web, mcp) can call
 * `pool.end()` during graceful shutdown.
 */
export async function createDbClient(
  databaseUrl: string,
  options: CreateDbClientOptions = {},
): Promise<{ db: DbClient; pool: Pool }> {
  if (!databaseUrl) {
    throw new Error(
      '[@concierge/db] createDbClient: databaseUrl is required (expected a Postgres connection string).',
    );
  }
  const pool = new Pool({ connectionString: databaseUrl });
  // pg.Pool's 'error' event fires for idle-client failures (network blip, PG
  // restart, PgBouncer kill). Without a listener Node crashes the process.
  pool.on('error', (err) => {
    if (options.onPoolError) options.onPoolError(err);
    // No default behavior — silently swallowing is intentional: the next
    // checkout will get a fresh client. Consumer can opt into logging.
  });
  if (options.ping) {
    // Eagerly validate connection so misconfig surfaces at boot, not mid-tick.
    await pool.query('SELECT 1');
  }
  const db = drizzle(pool, { schema });
  return { db, pool };
}
