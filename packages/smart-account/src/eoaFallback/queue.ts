import { type DbClient, type EoaTx, eoaTxQueue } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { and, eq, inArray } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const valueSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .refine((v) => v.length <= 78, { message: 'value exceeds uint256 (max 78 decimal digits)' });
const userIdSchema = z.string().min(1).max(256);
const errorMsgSchema = z.string().min(1).max(2048);

function assertUuid(value: string, field: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] queue: ${field} is not a valid UUID.`,
    );
  }
}

export interface EnqueueInput {
  readonly userId: string;
  readonly agentId: string;
  readonly to: Address;
  readonly data: Hex;
  /** unsigned-decimal wei, ≤78 digits. */
  readonly value: string;
}

export type QueueRow = EoaTx;

/**
 * Discriminated return type for state-machine writes.
 *
 *   `updated`        — UPDATE matched. row is the freshly-written state.
 *   `lost-race`      — row IS in an expected `from` state, but the UPDATE
 *                      missed because a concurrent worker won the CAS.
 *                      Idempotent-retryable; do NOT escalate to operator.
 *   `wrong-state`    — row exists, owned by the right tenant, but is in a
 *                      terminal/unrelated state (e.g. failed/confirmed when
 *                      markSigned was attempted). Operator-visible bug.
 *   `not-found`      — row id doesn't exist.
 *   `not-authorized` — row exists but belongs to a different tenant. Same
 *                      shape as not-found by design (no info leak).
 */
export type MarkResult =
  | { kind: 'updated'; row: QueueRow }
  | { kind: 'lost-race'; current: QueueRow }
  | { kind: 'wrong-state'; current: QueueRow }
  | { kind: 'not-found' }
  | { kind: 'not-authorized' };

function assertEnqueueInput(input: EnqueueInput): void {
  if (!userIdSchema.safeParse(input.userId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: userId must be 1-256 chars.`,
    );
  }
  assertUuid(input.agentId, 'agentId');
  if (!addressSchema.safeParse(input.to).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: to is not a valid address.`,
    );
  }
  if (!hexSchema.safeParse(input.data).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: data is not byte-aligned 0x-prefixed hex.`,
    );
  }
  if (!valueSchema.safeParse(input.value).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: value is not an unsigned-decimal-string wei ≤ 78 digits.`,
    );
  }
}

export async function enqueue(
  db: DbClient,
  input: EnqueueInput,
): Promise<{ id: string; createdAt: Date }> {
  assertEnqueueInput(input);
  const [row] = await db
    .insert(eoaTxQueue)
    .values({
      userId: input.userId,
      agentId: input.agentId,
      to: input.to,
      data: input.data,
      value: input.value,
      status: 'pending',
    })
    .returning({ id: eoaTxQueue.id, createdAt: eoaTxQueue.createdAt });
  if (!row) {
    // DB invariant violation, not a caller config bug.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: INSERT ... RETURNING returned no row (DB invariant violated).`,
    );
  }
  return row;
}

/**
 * Returns ONLY pending rows for (agentId, expectedUserId). Per-tenant isolation:
 * a stolen/guessed agentId from another userId returns empty, not other tenants'
 * rows. Mirrors story-54's IDOR pattern.
 */
export async function getPending(
  db: DbClient,
  args: { agentId: string; expectedUserId: string },
): Promise<readonly QueueRow[]> {
  assertUuid(args.agentId, 'agentId');
  if (!userIdSchema.safeParse(args.expectedUserId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] getPending: expectedUserId must be 1-256 chars.`,
    );
  }
  return db
    .select()
    .from(eoaTxQueue)
    .where(
      and(
        eq(eoaTxQueue.agentId, args.agentId),
        eq(eoaTxQueue.userId, args.expectedUserId),
        eq(eoaTxQueue.status, 'pending'),
      ),
    );
}

async function probeAndExplain(
  db: DbClient,
  id: string,
  expectedUserId: string,
  expectedFromStates: readonly QueueRow['status'][],
): Promise<MarkResult> {
  const [row] = await db.select().from(eoaTxQueue).where(eq(eoaTxQueue.id, id)).limit(1);
  if (!row) return { kind: 'not-found' };
  if (row.userId !== expectedUserId) return { kind: 'not-authorized' };
  // Distinguish lost-CAS-race (row IS in a legal from-state — benign retry)
  // from terminal-state drift (row in confirmed/failed when we expected
  // pending/signed — real bug, operator-visible).
  if ((expectedFromStates as readonly string[]).includes(row.status)) {
    return { kind: 'lost-race', current: row };
  }
  return { kind: 'wrong-state', current: row };
}

/**
 * Transitions pending → signed for (id, expectedUserId). Conditional UPDATE
 * gates on status='pending' AND userId=expectedUserId. On miss, the disambig
 * probe distinguishes not-found vs not-authorized vs wrong-state.
 */
export async function markSigned(
  db: DbClient,
  args: { id: string; expectedUserId: string; signedTx: Hex; txHash: Hex },
): Promise<MarkResult> {
  assertUuid(args.id, 'id');
  const [row] = await db
    .update(eoaTxQueue)
    .set({ status: 'signed', signedTx: args.signedTx, txHash: args.txHash })
    .where(
      and(
        eq(eoaTxQueue.id, args.id),
        eq(eoaTxQueue.userId, args.expectedUserId),
        eq(eoaTxQueue.status, 'pending'),
      ),
    )
    .returning();
  if (row) return { kind: 'updated', row };
  return probeAndExplain(db, args.id, args.expectedUserId, ['pending']);
}

export async function markConfirmed(
  db: DbClient,
  args: { id: string; expectedUserId: string; blockNumber: bigint },
): Promise<MarkResult> {
  assertUuid(args.id, 'id');
  const [row] = await db
    .update(eoaTxQueue)
    .set({ status: 'confirmed', blockNumber: args.blockNumber })
    .where(
      and(
        eq(eoaTxQueue.id, args.id),
        eq(eoaTxQueue.userId, args.expectedUserId),
        eq(eoaTxQueue.status, 'signed'),
      ),
    )
    .returning();
  if (row) return { kind: 'updated', row };
  return probeAndExplain(db, args.id, args.expectedUserId, ['signed']);
}

/**
 * Transitions pending|signed → failed. Confirmed and failed are TERMINAL —
 * markFailed must NEVER overwrite a confirmed row (would corrupt the
 * ERC-8004 attestation pipeline downstream).
 */
export async function markFailed(
  db: DbClient,
  args: { id: string; expectedUserId: string; error: string },
): Promise<MarkResult> {
  assertUuid(args.id, 'id');
  if (!errorMsgSchema.safeParse(args.error).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] markFailed: error must be 1-2048 chars (silent-failure rule + DB CHECK).`,
    );
  }
  const [row] = await db
    .update(eoaTxQueue)
    .set({ status: 'failed', error: args.error })
    .where(
      and(
        eq(eoaTxQueue.id, args.id),
        eq(eoaTxQueue.userId, args.expectedUserId),
        inArray(eoaTxQueue.status, ['pending', 'signed']),
      ),
    )
    .returning();
  if (row) return { kind: 'updated', row };
  return probeAndExplain(db, args.id, args.expectedUserId, ['pending', 'signed']);
}
