import { type DbClient, sessionKeys } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type {
  OnChainRevoker,
  RevocationEventEmitter,
  RevokeSessionKeyResult,
} from './revokeSessionKey.ts';
import { isRevocationPartialFailure, revokeSessionKey } from './revokeSessionKey.ts';

const uuidSchema = z.string().uuid();

export interface EmergencyStopConfig {
  readonly db: DbClient;
  /**
   * SECURITY: Caller MUST verify the authenticated principal owns this
   * agentId before invocation. This function performs NO ownership check.
   * Mirrors story-53's expectedAgentId pattern at the per-key boundary.
   */
  readonly agentId: string;
  readonly onChainRevoker: OnChainRevoker;
  readonly events?: RevocationEventEmitter;
  /**
   * Max concurrent per-key revocations. Default 2. The on-chain step submits
   * a UserOp through Pimlico + signs with the agent's owner EOA. Unbounded
   * fan-out causes (a) Pimlico rate-limit failures, (b) ZeroDev kernel nonce
   * collisions because nonces are per-account. Tune up for high-throughput
   * agents only after verifying bundler quota.
   */
  readonly maxConcurrency?: number;
}

const DEFAULT_CONCURRENCY = 2;

export type PartialFailure = ConciergeError & { type: 'RevocationPartialFailure' };

export interface EmergencyStopResult {
  /** Per-key successes. `length === revokedCount`. */
  readonly revoked: readonly RevokeSessionKeyResult[];
  /** DB succeeded, on-chain failed — caller must retry the on-chain step. */
  readonly partialFailures: readonly { sessionKeyId: string; cause: PartialFailure }[];
  /**
   * Anything else (e.g. race delete, transient DB error). Surfaced rather than
   * thrown so a single bad key never aborts an in-progress emergency stop.
   */
  readonly unexpectedFailures: readonly { sessionKeyId: string; cause: unknown }[];
}

/**
 * Revokes ALL active session keys for an agent. Idempotent: returns empty
 * arrays when no active keys exist (NOT a throw).
 *
 * Failure isolation: per-key failures (partial-failure OR unexpected) go to
 * separate result buckets. The function NEVER throws on a per-key error,
 * because emergency-stop semantics require best-effort coverage of the fleet
 * — exactly when something is going wrong is the worst time to abort.
 */
export async function emergencyStop(config: EmergencyStopConfig): Promise<EmergencyStopResult> {
  if (!uuidSchema.safeParse(config.agentId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] emergencyStop: agentId is not a valid UUID.`,
    );
  }

  const active = await config.db
    .select({ id: sessionKeys.id })
    .from(sessionKeys)
    .where(and(eq(sessionKeys.agentId, config.agentId), isNull(sessionKeys.revokedAt)));
  if (active.length === 0) {
    return { revoked: [], partialFailures: [], unexpectedFailures: [] };
  }

  const concurrency = Math.max(1, config.maxConcurrency ?? DEFAULT_CONCURRENCY);
  const revoked: RevokeSessionKeyResult[] = [];
  const partialFailures: { sessionKeyId: string; cause: PartialFailure }[] = [];
  const unexpectedFailures: { sessionKeyId: string; cause: unknown }[] = [];

  // Pool with bounded concurrency. Promise.allSettled with unbounded fan-out
  // collides with Pimlico rate limits and ZeroDev per-account nonces.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < active.length) {
      const i = cursor++;
      const id = active[i]?.id;
      if (id === undefined) continue;
      try {
        const result = await revokeSessionKey({
          db: config.db,
          sessionKeyId: id,
          expectedAgentId: config.agentId,
          onChainRevoker: config.onChainRevoker,
          ...(config.events !== undefined && { events: config.events }),
        });
        revoked.push(result);
      } catch (err) {
        if (isRevocationPartialFailure(err)) {
          partialFailures.push({ sessionKeyId: id, cause: err });
        } else {
          // Surface unexpected failures to stderr at push time — operators
          // need a signal even if the caller never inspects this bucket.
          // biome-ignore lint/suspicious/noConsole: operational signal for unexpected revocation failure
          console.error(
            `[@concierge/smart-account] emergencyStop: unexpected revocation failure for '${id}'`,
            { agentId: config.agentId, error: err },
          );
          unexpectedFailures.push({ sessionKeyId: id, cause: err });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, active.length) }, () => worker()));
  return { revoked, partialFailures, unexpectedFailures };
}
