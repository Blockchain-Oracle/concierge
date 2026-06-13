import { randomUUID } from 'node:crypto';
import type { Address, Hex } from 'viem';
import type { QueueRow } from '../queue.ts';

export const USER_ID = 'user-1';
export const OTHER_USER = 'user-2';
export const AGENT_A = '11111111-1111-4111-8111-111111111111';
export const AGENT_B = '22222222-2222-4222-8222-222222222222';
export const TO = '0x1234567890123456789012345678901234567890' as Address;
export const DATA = '0xdeadbeef' as Hex;
export const VALUE = '1000000000000000000';
export const TX_HASH = '0x4444444444444444444444444444444444444444444444444444444444444444' as Hex;
export const CHAIN_ID = 5003;
export const BASE_ENQ = { userId: USER_ID, agentId: AGENT_A, to: TO, data: DATA, value: VALUE };

const STATUSES = ['pending', 'signed', 'confirmed', 'failed'];

interface ExtractResult {
  literals: string[];
  statusSet: string[];
}

export function extractLiterals(where: unknown): ExtractResult {
  const literals: string[] = [];
  const statusSet: Set<string> = new Set();
  const seen = new WeakSet<object>();
  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
      return;
    }
    // biome-ignore lint/suspicious/noExplicitAny: drizzle internals
    const n = node as any;
    if (typeof n.value === 'string') {
      if (STATUSES.includes(n.value)) {
        statusSet.add(n.value);
      } else if (!/is null/i.test(n.value)) {
        literals.push(n.value);
      }
    }
    if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) walk(c);
  }
  walk(where);
  return { literals, statusSet: [...statusSet] };
}

export function matchRow(r: QueueRow, lits: string[], statusSet: string[]): boolean {
  for (const lit of lits) {
    if (r.id !== lit && r.userId !== lit && r.agentId !== lit && r.status !== lit) {
      return false;
    }
  }
  if (statusSet.length > 0 && !statusSet.includes(r.status)) return false;
  return true;
}

export function makeDb(): {
  // biome-ignore lint/suspicious/noExplicitAny: stub
  db: any;
  rows: QueueRow[];
} {
  const rows: QueueRow[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: stub
  const db: any = {
    insert: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: drizzle
      values: (v: any) => ({
        returning: async (_proj?: unknown) => {
          const row: QueueRow = {
            id: randomUUID(),
            userId: v.userId,
            agentId: v.agentId,
            to: v.to,
            data: v.data,
            value: v.value,
            status: v.status,
            signedTx: null,
            txHash: null,
            blockNumber: null,
            error: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          rows.push(row);
          return [{ id: row.id, createdAt: row.createdAt }];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          const { literals: lits, statusSet } = extractLiterals(w);
          const result = rows.filter((r) => matchRow(r, lits, statusSet));
          return {
            limit: async (_n: number) => result,
            // biome-ignore lint/suspicious/noThenProperty: drizzle awaitable stub
            then: (resolve: (v: unknown) => unknown) => resolve(result),
          };
        },
      }),
    }),
    update: () => ({
      // biome-ignore lint/suspicious/noExplicitAny: stub
      set: (patch: any) => ({
        where: (w: unknown) => ({
          returning: async () => {
            const { literals: lits, statusSet } = extractLiterals(w);
            const updated: QueueRow[] = [];
            for (const r of rows) {
              if (!matchRow(r, lits, statusSet)) continue;
              Object.assign(r, patch, { updatedAt: new Date() });
              updated.push(r);
            }
            return updated;
          },
        }),
      }),
    }),
  };
  return { db, rows };
}
