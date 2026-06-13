import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from '../../tick.ts';
import type { TickConfig } from '../../types.ts';
import { AGENT_ID, buildTickConfig } from './setup.ts';

afterEach(() => vi.restoreAllMocks());

describe('e2e LockFailure — lock.acquire throws → ConciergeError; credentials sanitized', () => {
  it('lock.acquire rejects with secret-bearing message → ConciergeError(LockError); no creds in message; lock.release NOT called', async () => {
    const base = buildTickConfig();
    const releaseSpy = vi.fn();
    const bad: TickConfig = {
      ...base.config,
      lock: {
        acquire: vi
          .fn()
          .mockRejectedValue(new Error('redis ECONNREFUSED redis://user:SUPER_SECRET@host:6379/0')),
        release: releaseSpy,
      },
    };
    await expect(tick(bad)).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      const cause = e.cause as { message?: string } | undefined;
      const everywhere = `${e.message}\n${cause?.message ?? ''}\n${JSON.stringify(e.metadata ?? {})}`;
      return (
        e.type === 'LockError' &&
        !everywhere.includes('SUPER_SECRET') &&
        e.message.includes(AGENT_ID)
      );
    });
    expect(releaseSpy).not.toHaveBeenCalled();
  });
});
