import { describe, expect, it, vi } from 'vitest';
import { createLock } from '../lock.ts';

interface FakeRedis {
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}

function makeRedis(opts: { setReturns?: string | null } = {}): FakeRedis {
  const setReturn = 'setReturns' in opts ? opts.setReturns : 'OK';
  return {
    set: vi.fn().mockResolvedValue(setReturn),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe('createLock — Redis NX semantics', () => {
  it('acquire calls SET ... PX ttl NX and returns true on OK', async () => {
    const redis = makeRedis({ setReturns: 'OK' });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    const got = await lock.acquire('lock:agent:a', 30_000);
    expect(got).toBe(true);
    expect(redis.set).toHaveBeenCalledWith('lock:agent:a', expect.any(String), 'PX', 30_000, 'NX');
  });

  it('nonce uses crypto.randomUUID (36 chars, 4-2-1 hex shape — NOT Math.random)', async () => {
    const redis = makeRedis({ setReturns: 'OK' });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.acquire('lock:agent:a', 30_000);
    const nonce = redis.set.mock.calls[0]?.[1] as string;
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('acquire returns false when SET returns null (lock held by another holder)', async () => {
    const redis = makeRedis({ setReturns: null });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    const got = await lock.acquire('lock:agent:a', 30_000);
    expect(got).toBe(false);
  });

  it('release runs Lua check+DEL with the per-acquire nonce', async () => {
    const redis = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.acquire('lock:agent:a', 30_000);
    await lock.release('lock:agent:a');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [, keyCount, key] = redis.eval.mock.calls[0] ?? [];
    expect(keyCount).toBe(1);
    expect(key).toBe('lock:agent:a');
  });

  it('release is a no-op when this lock never acquired the key', async () => {
    const redis = makeRedis();
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.release('lock:agent:never-acquired');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('CLOSURE-SCOPED nonceFor: two separate createLock instances do NOT share state', async () => {
    const redisA = makeRedis({ setReturns: 'OK' });
    const redisB = makeRedis({ setReturns: 'OK' });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lockA = createLock(redisA as any);
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lockB = createLock(redisB as any);
    await lockA.acquire('shared-key', 1000);
    // lockB should NOT know about shared-key — its nonceFor is independent.
    await lockB.release('shared-key');
    expect(redisB.eval).not.toHaveBeenCalled();
    // lockA still owns its nonce.
    await lockA.release('shared-key');
    expect(redisA.eval).toHaveBeenCalledTimes(1);
  });

  it('acquire generates distinct nonces per call', async () => {
    const redis = makeRedis({ setReturns: 'OK' });
    // biome-ignore lint/suspicious/noExplicitAny: fake redis
    const lock = createLock(redis as any);
    await lock.acquire('lock:a', 1000);
    await lock.acquire('lock:b', 1000);
    expect(redis.set.mock.calls[0]?.[1]).not.toBe(redis.set.mock.calls[1]?.[1]);
  });
});
