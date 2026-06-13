import { type DbClient, type EoaTx, eoaTxQueue } from '@concierge/db';
import { ConciergeError } from '@concierge/sdk';
import { and, eq } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

const uuidSchema = z.string().uuid();
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
/** unsigned-decimal-string wei, ≤78 digits (uint256 max). Mirrors the CHECK constraint. */
const valueSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .refine((v) => v.length <= 78, {
    message: 'value exceeds uint256 (max 78 decimal digits)',
  });

export interface EnqueueInput {
  readonly userId: string;
  readonly agentId: string;
  readonly to: Address;
  readonly data: Hex;
  /** unsigned-decimal wei, ≤78 digits. */
  readonly value: string;
}

export type QueueRow = EoaTx;

function assertEnqueueInput(input: EnqueueInput): void {
  if (!uuidSchema.safeParse(input.agentId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: agentId is not a valid UUID.`,
    );
  }
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

/**
 * Inserts a new pending tx into eoa_tx_queue. Validates input client-side
 * before the DB CHECK constraints fire — gives the caller a typed error
 * with column context instead of a raw PG check-violation throw.
 *
 * Concurrency: Postgres `INSERT ... RETURNING id` is atomic, so 100 parallel
 * enqueues across N agents each get a unique row (no row dropped, no
 * collision). The defaultRandom UUID primary key avoids any sequence
 * contention.
 */
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
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] enqueue: INSERT ... RETURNING returned no row.`,
    );
  }
  return row;
}

/**
 * Returns ONLY rows in status='pending' for the given agentId. Per-agent
 * isolation — never returns another agent's rows even if the caller passed
 * a wrong agentId (the WHERE pins agentId tightly).
 */
export async function getPending(
  db: DbClient,
  args: { agentId: string },
): Promise<readonly QueueRow[]> {
  if (!uuidSchema.safeParse(args.agentId).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] getPending: agentId is not a valid UUID.`,
    );
  }
  return db
    .select()
    .from(eoaTxQueue)
    .where(and(eq(eoaTxQueue.agentId, args.agentId), eq(eoaTxQueue.status, 'pending')));
}

/**
 * Transitions pending → signed, conditional on the row currently being
 * pending. The WHERE clause acts as a soft state machine guard so a
 * concurrent sender-double-fire cannot push signed → pending → signed.
 *
 * Returns the updated row. Returns null when the row no longer matches
 * (already signed by a concurrent caller, deleted, or wrong id).
 */
export async function markSigned(
  db: DbClient,
  args: { id: string; signedTx: Hex; txHash: Hex },
): Promise<QueueRow | null> {
  if (!uuidSchema.safeParse(args.id).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] markSigned: id is not a valid UUID.`,
    );
  }
  const [row] = await db
    .update(eoaTxQueue)
    .set({ status: 'signed', signedTx: args.signedTx, txHash: args.txHash })
    .where(and(eq(eoaTxQueue.id, args.id), eq(eoaTxQueue.status, 'pending')))
    .returning();
  return row ?? null;
}

export async function markConfirmed(
  db: DbClient,
  args: { id: string; blockNumber: bigint },
): Promise<QueueRow | null> {
  if (!uuidSchema.safeParse(args.id).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] markConfirmed: id is not a valid UUID.`,
    );
  }
  const [row] = await db
    .update(eoaTxQueue)
    .set({ status: 'confirmed', blockNumber: args.blockNumber })
    .where(and(eq(eoaTxQueue.id, args.id), eq(eoaTxQueue.status, 'signed')))
    .returning();
  return row ?? null;
}

export async function markFailed(
  db: DbClient,
  args: { id: string; error: string },
): Promise<QueueRow | null> {
  if (!uuidSchema.safeParse(args.id).success) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] markFailed: id is not a valid UUID.`,
    );
  }
  if (args.error.length === 0) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] markFailed: error message MUST be non-empty (silent-failure rule + DB CHECK).`,
    );
  }
  // status='failed' from pending OR signed — both are legal terminal failures.
  const [row] = await db
    .update(eoaTxQueue)
    .set({ status: 'failed', error: args.error })
    .where(eq(eoaTxQueue.id, args.id))
    .returning();
  return row ?? null;
}
