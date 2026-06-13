import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { TickLock } from './types.ts';

/**
 * Redis NX lock. The Lua release script does an atomic check+DEL so a stale
 * TTL expiry can't accidentally drop someone else's lock. Nonce uses
 * `crypto.randomUUID()` (security CWE-338 — Math.random predictable enough
 * for spoofed release racing).
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`.trim();

export function createLock(redis: Redis): TickLock {
  // Closure-scoped per createLock() call — module-global Map was a cross-
  // instance + cross-test contamination smell flagged by 4 reviewers.
  const nonceFor = new Map<string, string>();
  return {
    async acquire(key: string, ttlMs: number): Promise<boolean> {
      const nonce = randomUUID();
      const ok = await redis.set(key, nonce, 'PX', ttlMs, 'NX');
      if (ok === 'OK') {
        nonceFor.set(key, nonce);
        return true;
      }
      return false;
    },
    async release(key: string): Promise<void> {
      const nonce = nonceFor.get(key);
      if (nonce === undefined) {
        // We never held it (acquire never returned true OR already released).
        // The bare return is intentional but observable through tick.ts which
        // wraps release() in its own try/catch and logs.
        return;
      }
      nonceFor.delete(key);
      // biome-ignore lint/suspicious/noExplicitAny: ioredis eval typing
      await (redis as any).eval(RELEASE_SCRIPT, 1, key, nonce);
    },
  };
}
