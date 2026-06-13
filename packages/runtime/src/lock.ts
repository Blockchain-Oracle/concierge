import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { ReleaseOutcome, TickLock } from './types.ts';

/**
 * Redis NX lock. Atomic Lua check+DEL release with a `crypto.randomUUID`
 * nonce; closure-scoped `nonceFor` Map (avoids cross-instance contamination
 * + the same-key overwrite race that would silently release another
 * holder's lock).
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`.trim();

export function createLock(redis: Redis): TickLock {
  const nonceFor = new Map<string, string>();
  return {
    async acquire(key: string, ttlMs: number): Promise<boolean> {
      // Defensive: if THIS instance already holds the key, refuse the second
      // acquire instead of overwriting the in-memory nonce — that overwrite
      // would cause the first holder's release to use the wrong nonce and
      // silently release the second holder's lock.
      if (nonceFor.has(key)) return false;
      const nonce = randomUUID();
      const ok = await redis.set(key, nonce, 'PX', ttlMs, 'NX');
      if (ok === 'OK') {
        nonceFor.set(key, nonce);
        return true;
      }
      return false;
    },
    async release(key: string): Promise<ReleaseOutcome> {
      const nonce = nonceFor.get(key);
      if (nonce === undefined) return 'not-held';
      nonceFor.delete(key);
      // Lua DEL returns 1 on success, 0 when our nonce didn't match
      // (TTL expired and someone else owns the key now — the race the
      // CAS exists to prevent). Surface the distinction so callers can
      // alert on stale-holder situations.
      // biome-ignore lint/suspicious/noExplicitAny: ioredis eval typing
      const result = await (redis as any).eval(RELEASE_SCRIPT, 1, key, nonce);
      return result === 1 ? 'released' : 'nonce-mismatch';
    },
  };
}
