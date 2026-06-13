import { describe, expect, it, vi } from 'vitest';
import { createLock } from '../lock.ts';

interface FakeRedis {
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}

function makeRedis(opts: { setReturns?: string | null; evalReturns?: number } = {}): FakeRedis {
  const setReturn = 'setReturns' in opts ? opts.setReturns : 'OK';
  const evalReturn = opts.evalReturns ?? 1;
  return {
    set: vi.fn().mockResolvedValue(setReturn),
    eval: vi.fn().mockResolvedValue(evalReturn),
  };
}

describe('createLock — Redis NX semantics', () => {
  it('acquire calls SET ... PX ttl NX and returns true on OK', async () => {
    const redis = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    expect(await lock.acquire('k1', 30_000)).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('k1', expect.any(String), 'PX', 30_000, 'NX');
  });

  it('nonce is a UUID (crypto.randomUUID, NOT Math.random)', async () => {
    const redis = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.acquire('k1', 30_000);
    const nonce = redis.set.mock.calls[0]?.[1] as string;
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('acquire returns false when SET returns null', async () => {
    const redis = makeRedis({ setReturns: null });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    expect(await lock.acquire('k1', 30_000)).toBe(false);
  });

  it('release returns "released" when Lua DEL succeeds (1)', async () => {
    const redis = makeRedis({ evalReturns: 1 });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.acquire('k1', 30_000);
    expect(await lock.release('k1')).toBe('released');
  });

  it('release returns "not-held" when this instance never acquired the key', async () => {
    const redis = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    expect(await lock.release('never-acquired')).toBe('not-held');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('release returns "nonce-mismatch" when Lua DEL=0 (TTL expired, someone else owns)', async () => {
    const redis = makeRedis({ evalReturns: 0 });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.acquire('k1', 30_000);
    expect(await lock.release('k1')).toBe('nonce-mismatch');
  });

  it('SECURITY: same-instance double acquire on same key → second returns false (no nonce overwrite)', async () => {
    const redis = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    expect(await lock.acquire('k1', 1000)).toBe(true);
    // Without the round-2 guard, the second acquire would overwrite the
    // first nonce in the in-memory Map → first release uses second nonce
    // → silent foreign-lock release.
    expect(await lock.acquire('k1', 1000)).toBe(false);
    // Released the first holder's lock cleanly.
    const r1 = await lock.release('k1');
    expect(r1).toBe('released');
  });

  it('closure-scoped nonceFor: two createLock instances do NOT share state', async () => {
    const redisA = makeRedis();
    const redisB = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lockA = createLock(redisA as any);
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lockB = createLock(redisB as any);
    await lockA.acquire('shared-key', 1000);
    expect(await lockB.release('shared-key')).toBe('not-held');
    expect(redisB.eval).not.toHaveBeenCalled();
    expect(await lockA.release('shared-key')).toBe('released');
    expect(redisA.eval).toHaveBeenCalledTimes(1);
  });
});
