import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { and, eq, isNull } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

const uuidSchema = z.string().uuid();

/**
 * Event map keyed by event name. Adding a second event is a one-line change to
 * `RevocationEvents`; the `emit` overload stays the same.
 */
export interface RevocationEvents {
  'agent.revoked': { sessionKeyId: string; agentId: string; revokedAt: Date };
}

export interface RevocationEventEmitter {
  emit<E extends keyof RevocationEvents>(
    event: E,
    payload: RevocationEvents[E],
  ): void | Promise<void>;
}

/**
 * Submits the on-chain uninstall of the session-key validator. Closure-captures
 * the kernel client + owner signer in the caller's scope. Caller is responsible
 * for sanitizing any RPC/bundler error before rethrowing so we don't smuggle
 * Pimlico apiKey URLs into `ConciergeError.cause`.
 */
export type OnChainRevoker = (input: { sessionKeyAddress: Address }) => Promise<{ txHash: Hex }>;

/**
 * Runtime guard for `RevocationPartialFailure` errors. Use in catch handlers
 * or when filtering EmergencyStopResult buckets to narrow without `as` casts.
 */
export function isRevocationPartialFailure(
  err: unknown,
): err is ConciergeError & { type: 'RevocationPartialFailure' } {
  return err instanceof ConciergeError && err.type === 'RevocationPartialFailure';
}

/**
 * Defense-in-depth scrubber for retry errors before they're stored in the
 * AggregateError cause. The OnChainRevoker's JSDoc says callers must sanitize,
 * but a non-compliant revoker would smuggle Pimlico apiKey URL fragments into
 * `err.stack` (which ConciergeError.toJSON omits but `console.error(err)` does
 * not). Strips common apiKey/token query-param shapes.
 */
function scrubLeakage(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const KEY_PARAM_RE = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"'<>]+/gi;
  const sanitized = err.message.replace(KEY_PARAM_RE, '$1<redacted>');
  if (sanitized === err.message) return err;
  const out = new Error(sanitized);
  out.name = err.name;
  if (err.stack) out.stack = err.stack.replace(KEY_PARAM_RE, '$1<redacted>');
  return out;
}

export interface RevokeSessionKeyConfig {
  readonly db: DbClient;
  readonly sessionKeyId: string;
  /**
   * Required IDOR defense. The UPDATE matches only rows belonging to this
   * agent — a stolen/guessed sessionKeyId from another tenant fails as
   * `NotAuthorized`. Mirror of story-53's `loadSessionKey({ expectedAgentId })`.
   */
  readonly expectedAgentId: string;
  readonly onChainRevoker: OnChainRevoker;
  readonly events?: RevocationEventEmitter;
  /**
   * Total attempts for the on-chain step. Default 2 (initial + 1 retry).
   * Pass 1 in serverless/edge handlers where the backoff would exhaust the
   * runtime budget — retry from a queue instead.
   */
  readonly onChainMaxAttempts?: number;
  /** Backoff between on-chain attempts (ms). Default 5000. */
  readonly onChainBackoffMs?: number;
}

export interface RevokeSessionKeyResult {
  readonly sessionKeyId: string;
  readonly agentId: string;
  readonly revokedAt: Date;
  /**
   * `null` on the idempotent re-revoke path — DB was already revoked
   * previously and the on-chain step is NOT re-attempted (second uninstall
   * would revert and surface as a false-alarm RevocationPartialFailure).
   */
  readonly onChainTxHash: Hex | null;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 5_000;

export async function revokeSessionKey(
  config: RevokeSessionKeyConfig,
): Promise<RevokeSessionKeyResult> {
  if (!uuidSchema.safeParse(config.sessionKeyId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] revokeSessionKey: sessionKeyId is not a valid UUID.`,
    );
  }
  if (!uuidSchema.safeParse(config.expectedAgentId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] revokeSessionKey: expectedAgentId is not a valid UUID.`,
    );
  }

  const now = new Date();
  const updated = await config.db
    .update(sessionKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessionKeys.id, config.sessionKeyId),
        eq(sessionKeys.agentId, config.expectedAgentId),
        isNull(sessionKeys.revokedAt),
      ),
    )
    .returning({
      id: sessionKeys.id,
      agentId: sessionKeys.agentId,
      publicAddress: sessionKeys.publicAddress,
      revokedAt: sessionKeys.revokedAt,
    });

  const winner = updated[0];
  if (winner) {
    // returning() reads back the row we just SET — null here means schema
    // drift or driver column-mapping bug, NOT a normal state. Fail loudly
    // rather than substitute `now` and emit a phantom timestamp downstream.
    if (winner.revokedAt === null) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/smart-account] revokeSessionKey: UPDATE returned null revokedAt for session key '${winner.id}'. Schema or driver mismatch.`,
      );
    }
    const revokedAt = winner.revokedAt;
    const txHash = await runOnChainWithRetry(config, winner.publicAddress as Address);
    await emitRevokedEvent(config, {
      sessionKeyId: winner.id,
      agentId: winner.agentId,
      revokedAt,
    });
    return {
      sessionKeyId: winner.id,
      agentId: winner.agentId,
      revokedAt,
      onChainTxHash: txHash,
    };
  }

  // UPDATE matched zero rows. Probe by id only to disambiguate, but never
  // reveal cross-tenant existence (NotFound/NotAuthorized share shape).
  const probe = await config.db
    .select({
      id: sessionKeys.id,
      agentId: sessionKeys.agentId,
      revokedAt: sessionKeys.revokedAt,
    })
    .from(sessionKeys)
    .where(eq(sessionKeys.id, config.sessionKeyId))
    .limit(1);
  const found = probe[0];
  if (!found) {
    throw new ConciergeError(
      'SessionKeyNotFound',
      `[@concierge/smart-account] revokeSessionKey: session key not found.`,
    );
  }
  if (found.agentId !== config.expectedAgentId) {
    throw new ConciergeError(
      'NotAuthorized',
      `[@concierge/smart-account] revokeSessionKey: caller is not authorized to revoke this session key.`,
    );
  }
  if (found.revokedAt === null) {
    // Replication lag or torn write. Don't fabricate a timestamp.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] revokeSessionKey: UPDATE returned zero rows but row is unrevoked. Retry from primary.`,
    );
  }
  return {
    sessionKeyId: found.id,
    agentId: found.agentId,
    revokedAt: found.revokedAt,
    onChainTxHash: null,
  };
}

async function runOnChainWithRetry(
  config: RevokeSessionKeyConfig,
  sessionKeyAddress: Address,
): Promise<Hex> {
  const max = config.onChainMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = config.onChainBackoffMs ?? DEFAULT_BACKOFF_MS;
  if (!Number.isInteger(max) || max < 1) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] revokeSessionKey: onChainMaxAttempts must be a positive integer (got ${max}).`,
    );
  }
  const errors: unknown[] = [];
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const { txHash } = await config.onChainRevoker({ sessionKeyAddress });
      return txHash;
    } catch (err) {
      errors.push(scrubLeakage(err));
      if (attempt < max) await sleep(backoffMs);
    }
  }
  // Preserve every attempt's error so debugging doesn't lose the first failure.
  const aggregate = new AggregateError(
    errors,
    `on-chain uninstall failed across ${max} attempt(s)`,
  );
  throw new ConciergeError(
    'RevocationPartialFailure',
    `[@concierge/smart-account] revokeSessionKey: DB revoked but on-chain uninstall failed after ${max} attempt(s). Caller MUST retry the on-chain step — do NOT re-issue a key.`,
    aggregate,
    { dbRevoked: true, onChainRevoked: false },
  );
}

async function emitRevokedEvent(
  config: RevokeSessionKeyConfig,
  payload: RevocationEvents['agent.revoked'],
): Promise<void> {
  if (!config.events) return;
  try {
    await config.events.emit('agent.revoked', payload);
  } catch (err) {
    // Non-fatal but NEVER silent. stderr is MCP-safe per ADR-011.
    // biome-ignore lint/suspicious/noConsole: revocation event drop must be observable
    console.error(
      `[@concierge/smart-account] revokeSessionKey: agent.revoked emit failed (non-fatal)`,
      { sessionKeyId: payload.sessionKeyId, agentId: payload.agentId, error: err },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
