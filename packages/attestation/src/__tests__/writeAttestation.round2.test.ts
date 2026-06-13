import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { PinService } from '../pinService.ts';
import {
  type Erc8004AttestWriter,
  type WriteAttestationInputs,
  writeAttestation,
} from '../writeAttestation.ts';

const VALID_CIDV1 = 'bafybeibq2j5p4d3xrr5n6jxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhqxhq';
const ATTESTATION_UID = 'uid-1';
const TX_HASH: `0x${string}` = `0x${'d'.repeat(64)}`;

const INPUTS: WriteAttestationInputs = {
  agentId: '1',
  chainId: 5000,
  providerSchema: 'concierge.aave.v3.supply.v1',
  payload: { asset: '0xUSDC', amount: '100000000' },
  txHash: `0x${'a'.repeat(64)}`,
  createdAt: '2026-06-13T12:00:00Z',
};

function fakePinService(): PinService {
  return {
    name: 'pinata',
    async pin() {
      return { cid: VALID_CIDV1, pinId: `pinata:${VALID_CIDV1}` };
    },
  };
}

function fakeWriter(): Erc8004AttestWriter {
  return {
    async giveFeedback() {
      return { attestationUid: ATTESTATION_UID, txHash: TX_HASH };
    },
  };
}

describe('writeAttestation — round-2 hardening', () => {
  it('CRITICAL agentId leading zeros → ConfigError (canonical decimal only)', async () => {
    const pinata = fakePinService();
    const pinSpy = vi.spyOn(pinata, 'pin');
    await expect(
      writeAttestation(
        { ...INPUTS, agentId: '00001' },
        { pinDeps: { primary: pinata }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    expect(pinSpy).not.toHaveBeenCalled();
  });

  it('CRITICAL agentId empty string → ConfigError', async () => {
    await expect(
      writeAttestation(
        { ...INPUTS, agentId: '' },
        { pinDeps: { primary: fakePinService() }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('CRITICAL agentId >78 digits (overflow shape) → ConfigError BEFORE pin', async () => {
    const pinata = fakePinService();
    const pinSpy = vi.spyOn(pinata, 'pin');
    await expect(
      writeAttestation(
        { ...INPUTS, agentId: '1'.repeat(200) },
        { pinDeps: { primary: pinata }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    expect(pinSpy).not.toHaveBeenCalled();
  });

  it('CRITICAL uint256 max (78 digits, all 9s) is REJECTED if > 2^256-1', async () => {
    await expect(
      writeAttestation(
        { ...INPUTS, agentId: '9'.repeat(78) },
        { pinDeps: { primary: fakePinService() }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('boundary: 2^256-1 exactly is ACCEPTED (max valid uint256)', async () => {
    const max = (2n ** 256n - 1n).toString();
    const captured: { value: bigint | null } = { value: null };
    const writer: Erc8004AttestWriter = {
      async giveFeedback(args) {
        captured.value = args.agentId;
        return { attestationUid: ATTESTATION_UID, txHash: TX_HASH };
      },
    };
    await writeAttestation(
      { ...INPUTS, agentId: max },
      { pinDeps: { primary: fakePinService() }, writer },
    );
    expect(captured.value).toBe(2n ** 256n - 1n);
  });

  it('CRITICAL createdAt malformed → ConfigError BEFORE any IO', async () => {
    const pinata = fakePinService();
    const pinSpy = vi.spyOn(pinata, 'pin');
    await expect(
      writeAttestation(
        { ...INPUTS, createdAt: 'last tuesday' },
        { pinDeps: { primary: pinata }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    expect(pinSpy).not.toHaveBeenCalled();
  });

  it('CRITICAL pre-aborted caller signal → ConfigError BEFORE pin (no orphan)', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const pinata = fakePinService();
    const pinSpy = vi.spyOn(pinata, 'pin');
    await expect(
      writeAttestation(INPUTS, {
        pinDeps: { primary: pinata },
        writer: fakeWriter(),
        signal: ctl.signal,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    expect(pinSpy).not.toHaveBeenCalled();
  });

  it('CRITICAL pinService returns malformed CID → InvariantViolation AND orphan-pin log', async () => {
    const malformedPin: PinService = {
      name: 'pinata',
      async pin() {
        return { cid: 'not-a-cid', pinId: 'pinata:not-a-cid' };
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    let caught: unknown;
    try {
      await writeAttestation(INPUTS, {
        pinDeps: { primary: malformedPin },
        writer: fakeWriter(),
        logger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConciergeError);
    expect((caught as ConciergeError).type).toBe('InvariantViolation');
    expect(logger.error).toHaveBeenCalledTimes(1);
    const meta = logger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(meta?.['orphanCid']).toBe('not-a-cid');
    expect(meta?.['errName']).toBe('PinServiceContractViolation');
  });

  it('orphan log does NOT include dataURI (derivable from orphanCid)', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    await expect(
      writeAttestation(INPUTS, {
        pinDeps: { primary: fakePinService() },
        writer: {
          async giveFeedback() {
            throw new Error('chain stalled');
          },
        },
        logger,
      }),
    ).rejects.toBeDefined();
    const meta = logger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(meta).not.toHaveProperty('dataURI');
  });
});
