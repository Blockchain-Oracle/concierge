import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import { isUserEligible } from '../../selectors.ts';

const BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;
const USER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as const;

function makeClient(isBlocked: boolean) {
  return {
    readContract: vi.fn().mockResolvedValue(isBlocked),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  } as any;
}

describe('isUserEligible', () => {
  it('returns true when user is not blocked', async () => {
    const client = makeClient(false);
    expect(await isUserEligible(client, BLOCKLIST, USER)).toBe(true);
  });

  it('returns false when user is on the blocklist', async () => {
    const client = makeClient(true);
    expect(await isUserEligible(client, BLOCKLIST, USER)).toBe(false);
  });

  it('throws ConciergeError(RpcError) when blocklist query fails', async () => {
    const client = {
      readContract: vi.fn().mockRejectedValue(new Error('rpc timeout')),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    } as any;
    await expect(isUserEligible(client, BLOCKLIST, USER)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});
