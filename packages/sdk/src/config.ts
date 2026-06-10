import { z } from 'zod';
import { ConfigError, type ConfigErrorMetadata } from './errors.ts';

/**
 * Zod schema for all Concierge env vars (per ADR-016 / story-24).
 *
 * Design notes:
 * - MANTLE_CHAIN_ID: `z.coerce.number().refine((v): v is 5000 | 5003 => ...)` coerces
 *   the env string to a number then narrows to the literal union via a type-predicate
 *   refinement. TypeScript infers `5000 | 5003` without a cast; the custom message
 *   ("must be 5000 or 5003") replaces the non-actionable `invalid_union` "Invalid input".
 * - SENTRY_DSN: blank-or-whitespace-only treated as absent — `SENTRY_DSN=""` or
 *   `SENTRY_DSN=" "` (Docker/k8s ConfigMap injection) are the idiomatic "disabled" in
 *   deployment tooling; without this, a blank value crashes startup for an optional field.
 * - Optional credential fields (`ZERODEV_PROJECT_ID`, `PIMLICO_API_KEY`, etc.) use
 *   `.min(1)` so a blank value (`.env` line with no RHS) is rejected at startup rather
 *   than forwarded to ZeroDev/Pimlico/Li.Fi as an empty-string credential.
 * - `.superRefine()` guards the MANTLE_CHAIN_ID / MANTLE_RPC_URL invariant: both RPC URL
 *   fields default to their respective networks, but MANTLE_CHAIN_ID has no default — a
 *   misconfigured `MANTLE_CHAIN_ID=5003` without explicitly setting MANTLE_RPC_URL would
 *   silently point Sepolia traffic at mainnet. Defaults are public Mantle infrastructure;
 *   a misspelled private RPC env var falls back to public endpoints without error.
 * - `.transform()` maps UPPER_CASE env names → camelCase SDK fields so that
 *   `ConciergeConfig = z.output<typeof ConfigSchema>` is fully derived. Adding
 *   a field to the schema forces adding a transform line — no parallel list.
 */
export const ConfigSchema = z
  .object({
    // LLM
    ANTHROPIC_API_KEY: z
      .string()
      .min(20)
      .regex(/^sk-ant-/, 'must start with "sk-ant-"'),

    // Database + cache
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // Mantle network
    // NOTE: RPC URL defaults are public Mantle infrastructure. A misspelled custom
    // RPC env var (e.g. MANTLE_RPC_URl) is silently ignored — the fallback will
    // work but bypass your private node. Set explicitly in production.
    MANTLE_RPC_URL: z.string().url().default('https://rpc.mantle.xyz'),
    MANTLE_SEPOLIA_RPC_URL: z.string().url().default('https://rpc.sepolia.mantle.xyz'),
    // Type-predicate refinement infers output as `5000 | 5003` without a cast;
    // the custom message replaces the opaque `invalid_union` "Invalid input".
    MANTLE_CHAIN_ID: z.coerce.number().refine((v): v is 5000 | 5003 => v === 5000 || v === 5003, {
      message: 'must be 5000 (Mantle Mainnet) or 5003 (Mantle Sepolia)',
    }),

    // ZeroDev + Pimlico (smart account layer, E4) — .min(1) rejects blank values
    ZERODEV_PROJECT_ID: z.string().min(1).optional(),
    PIMLICO_API_KEY: z.string().min(1).optional(),

    // Externals — .min(1) rejects blank values so they aren't forwarded as credentials
    LIFI_API_KEY: z.string().min(1).optional(),
    PINATA_JWT: z.string().min(1).optional(),
    WEB3_STORAGE_TOKEN: z.string().min(1).optional(),

    // Observability — blank or whitespace-only treated as absent (PaaS / k8s idiom)
    SENTRY_DSN: z
      .string()
      .optional()
      .transform((v) => (v?.trim() === '' ? undefined : v?.trim()))
      .pipe(z.string().url().optional()),

    // Auth (web / MCP surfaces)
    PRIVY_APP_ID: z.string().min(1).optional(),
    PRIVY_SERVER_KEY: z.string().min(1).optional(),

    // NOTE: NODE_ENV defaults to 'development'. A missing NODE_ENV in a production
    // deployment silently enables development-mode behaviour. Set explicitly.
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .superRefine((raw, ctx) => {
    // Guard the chain ID / RPC URL invariant: MANTLE_RPC_URL defaults to mainnet,
    // but MANTLE_CHAIN_ID has no default. Setting MANTLE_CHAIN_ID=5003 without
    // overriding MANTLE_RPC_URL silently routes Sepolia transactions to mainnet.
    if (raw.MANTLE_CHAIN_ID === 5003 && raw.MANTLE_RPC_URL === 'https://rpc.mantle.xyz') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MANTLE_RPC_URL'],
        message:
          'MANTLE_CHAIN_ID=5003 (Sepolia) but MANTLE_RPC_URL is the mainnet default — set MANTLE_RPC_URL=https://rpc.sepolia.mantle.xyz or a custom Sepolia endpoint',
      });
    }
  })
  .transform((raw) => ({
    anthropicApiKey: raw.ANTHROPIC_API_KEY,
    databaseUrl: raw.DATABASE_URL,
    redisUrl: raw.REDIS_URL,
    mantleRpcUrl: raw.MANTLE_RPC_URL,
    mantleSepoliaRpcUrl: raw.MANTLE_SEPOLIA_RPC_URL,
    mantleChainId: raw.MANTLE_CHAIN_ID,
    zeroDevProjectId: raw.ZERODEV_PROJECT_ID,
    pimlicoApiKey: raw.PIMLICO_API_KEY,
    lifiApiKey: raw.LIFI_API_KEY,
    pinataJwt: raw.PINATA_JWT,
    web3StorageToken: raw.WEB3_STORAGE_TOKEN,
    sentryDsn: raw.SENTRY_DSN,
    privyAppId: raw.PRIVY_APP_ID,
    privyServerKey: raw.PRIVY_SERVER_KEY,
    nodeEnv: raw.NODE_ENV,
  }));

/**
 * Typed config returned by `loadConfig()`. Derived from `ConfigSchema` —
 * adding a field to the schema without a transform line produces a type error.
 */
export type ConciergeConfig = z.output<typeof ConfigSchema>;

/**
 * Validates env vars and returns a typed `ConciergeConfig`. Always throws
 * `ConfigError` on failure, with field-level summaries in `err.message` and
 * structured Zod issues in `err.metadata.issues`.
 *
 * Accepts an optional `env` override for testing (defaults to `process.env`).
 * Wrapped in try-catch to preserve the ConfigError contract even if a future
 * refine/transform callback throws unexpectedly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConciergeConfig {
  let result: ReturnType<typeof ConfigSchema.safeParse>;
  try {
    result = ConfigSchema.safeParse(env);
  } catch (err) {
    throw new ConfigError(
      `[@concierge/sdk] loadConfig: schema validation threw unexpectedly — ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err,
    );
  }
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    const metadata: ConfigErrorMetadata = { issues: result.error.issues };
    throw new ConfigError(`[@concierge/sdk] loadConfig: ${summary}`, metadata);
  }
  return result.data;
}
