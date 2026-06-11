import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { buildAttestationPayload, ONDO_ATTESTATION_SCHEMA } from '../../attestation.ts';

const USER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as const;

describe('buildAttestationPayload', () => {
  it('builds a valid payload for a non-zero balance', () => {
    const payload = buildAttestationPayload({
      chainId: 5000,
      user: USER,
      balance: 1_000_000_000_000_000_000n,
      multiplier: 1_067_000_000_000_000_000n,
      blockNumber: 12345,
    });
    expect(payload.schema).toBe(ONDO_ATTESTATION_SCHEMA);
    expect(payload.chain).toBe(5000);
    expect(payload.user).toBe(USER);
    expect(payload.balance).toBe('1000000000000000000');
    expect(payload.multiplier).toBe('1067000000000000000');
    expect(payload.blockNumber).toBe(12345);
    expect(payload.ts).toBeGreaterThan(0);
  });

  it('builds a valid payload for zero balance', () => {
    const payload = buildAttestationPayload({
      chainId: 5000,
      user: USER,
      balance: 0n,
      multiplier: 1_067_000_000_000_000_000n,
      blockNumber: 1,
    });
    expect(payload.balance).toBe('0');
  });

  it('throws ConciergeError(ConfigError) for negative balance', () => {
    let thrown: unknown;
    try {
      buildAttestationPayload({
        chainId: 5000,
        user: USER,
        balance: -1n,
        multiplier: 1_000_000_000_000_000_000n,
        blockNumber: 1,
      });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown instanceof ConciergeError && (thrown as ConciergeError).type === 'ConfigError',
    ).toBe(true);
  });

  it('throws ConciergeError(ConfigError) for zero multiplier (invalid pool price)', () => {
    let thrown: unknown;
    try {
      buildAttestationPayload({
        chainId: 5000,
        user: USER,
        balance: 1_000_000_000_000_000_000n,
        multiplier: 0n,
        blockNumber: 1,
      });
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown instanceof ConciergeError && (thrown as ConciergeError).type === 'ConfigError',
    ).toBe(true);
  });
});
