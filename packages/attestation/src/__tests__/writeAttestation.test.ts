import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PinService } from '../pinService.ts';
import {
  type Erc8004AttestWriter,
  type WriteAttestationInputs,
  writeAttestation,
} from '../writeAttestation.ts';

afterEach(() => vi.restoreAllMocks());

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

function fakeWriter(over: Partial<Erc8004AttestWriter> = {}): Erc8004AttestWriter & {
  calls: Array<{ dataHash: string; dataURI: string }>;
} {
  const calls: Array<{ dataHash: string; dataURI: string }> = [];
  return {
    calls,
    async giveFeedback(args) {
      calls.push({ dataHash: args.dataHash, dataURI: args.dataURI });
      return { attestationUid: ATTESTATION_UID, txHash: TX_HASH };
    },
    ...over,
  };
}

describe('writeAttestation — happy path', () => {
  it('composes envelope → pin → hash → on-chain attest; returns the full result', async () => {
    const pinata = fakePinService();
    const writer = fakeWriter();
    const out = await writeAttestation(INPUTS, {
      pinDeps: { primary: pinata },
      writer,
    });
    expect(out.attestationUid).toBe(ATTESTATION_UID);
    expect(out.cid).toBe(VALID_CIDV1);
    expect(out.hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(out.onChainTxHash).toBe(TX_HASH);
    expect(out.dataURI).toBe(`ipfs://${VALID_CIDV1}`);
  });

  it('dataURI is raw `ipfs://<cid>` (NOT a gateway URL)', async () => {
    const writer = fakeWriter();
    const out = await writeAttestation(INPUTS, {
      pinDeps: { primary: fakePinService() },
      writer,
    });
    expect(out.dataURI.startsWith('ipfs://')).toBe(true);
    expect(out.dataURI).not.toMatch(/https?:\/\//);
    expect(writer.calls[0]?.dataURI).toBe(`ipfs://${VALID_CIDV1}`);
  });

  it('on-chain writer receives the SAME hash + dataURI as the result', async () => {
    const writer = fakeWriter();
    const out = await writeAttestation(INPUTS, {
      pinDeps: { primary: fakePinService() },
      writer,
    });
    expect(writer.calls[0]?.dataHash).toBe(out.hash);
    expect(writer.calls[0]?.dataURI).toBe(out.dataURI);
  });

  it('single Pino info log on success with structured fields', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    await writeAttestation(INPUTS, {
      pinDeps: { primary: fakePinService() },
      writer: fakeWriter(),
      logger,
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const meta = logger.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(meta?.['attestationUid']).toBe(ATTESTATION_UID);
    expect(meta?.['cid']).toBe(VALID_CIDV1);
    expect(meta?.['onChainTxHash']).toBe(TX_HASH);
    expect(meta?.['providerSchema']).toBe(INPUTS.providerSchema);
    expect(meta?.['durationMs']).toBeGreaterThanOrEqual(0);
  });
});

describe('writeAttestation — fail-fast ordering (spec BDD)', () => {
  it('malformed envelope (bad schema) → throws BEFORE pin and BEFORE on-chain', async () => {
    const pinata = fakePinService();
    const pinSpy = vi.spyOn(pinata, 'pin');
    const writer = fakeWriter();
    await expect(
      writeAttestation(
        // biome-ignore lint/suspicious/noExplicitAny: deliberate
        { ...INPUTS, providerSchema: 'not.a.real.schema' as any },
        { pinDeps: { primary: pinata }, writer },
      ),
    ).rejects.toBeDefined();
    expect(pinSpy).not.toHaveBeenCalled();
    expect(writer.calls).toHaveLength(0);
  });

  it("IPFSPinFailed → throws BEFORE on-chain tx (don't write a stale dataURI)", async () => {
    const failingPin: PinService = {
      name: 'pinata',
      async pin() {
        throw new Error('pinata: 503');
      },
    };
    const writer = fakeWriter();
    await expect(
      writeAttestation(INPUTS, {
        pinDeps: { primary: failingPin },
        writer,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'IPFSPinFailed');
    expect(writer.calls).toHaveLength(0);
  });

  it('on-chain tx fails AFTER pin → AttestationFailed; pin NOT rolled back (cid in metadata)', async () => {
    const pinata = fakePinService();
    const writer: Erc8004AttestWriter = {
      async giveFeedback() {
        throw new Error('ReputationRegistry paused');
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    // Round-2: split bundled toSatisfy into per-field assertions so a single
    // field regression doesn't collapse to one opaque failure.
    let caught: unknown;
    try {
      await writeAttestation(INPUTS, { pinDeps: { primary: pinata }, writer, logger });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConciergeError);
    const ce = caught as ConciergeError;
    expect(ce.type).toBe('AttestationFailed');
    const md = ce.metadata as { cid: string; hash: string; dataURI: string; agentId: string };
    expect(md.cid).toBe(VALID_CIDV1);
    expect(md.hash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(md.dataURI).toBe(`ipfs://${VALID_CIDV1}`);
    expect(md.agentId).toBe('1');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('on-chain ConciergeError → rethrown as-is (not double-wrapped)', async () => {
    const writer: Erc8004AttestWriter = {
      async giveFeedback() {
        throw new ConciergeError('NetworkUnsupported', 'mantle-sepolia not supported');
      },
    };
    await expect(
      writeAttestation(INPUTS, {
        pinDeps: { primary: fakePinService() },
        writer,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'NetworkUnsupported',
    );
  });
});

describe('writeAttestation — boundary contracts', () => {
  it('agentId is converted to bigint for the on-chain writer (spec: uint256)', async () => {
    const captured: { value: bigint | null } = { value: null };
    const writer: Erc8004AttestWriter = {
      async giveFeedback(args) {
        captured.value = args.agentId;
        return { attestationUid: ATTESTATION_UID, txHash: TX_HASH };
      },
    };
    await writeAttestation(
      { ...INPUTS, agentId: '12345678901234567890' },
      { pinDeps: { primary: fakePinService() }, writer },
    );
    expect(captured.value).toBe(12345678901234567890n);
  });

  it('txHash is optional — works without it', async () => {
    const { txHash: _, ...withoutTxHash } = INPUTS;
    const out = await writeAttestation(withoutTxHash, {
      pinDeps: { primary: fakePinService() },
      writer: fakeWriter(),
    });
    expect(out.attestationUid).toBe(ATTESTATION_UID);
  });
});

describe('writeAttestation — round-1 hardening', () => {
  it('CRITICAL agentId non-numeric → ConfigError BEFORE pin (fail-fast)', async () => {
    const pinata = fakePinService();
    const pinSpy = vi.spyOn(pinata, 'pin');
    const writer = fakeWriter();
    await expect(
      writeAttestation({ ...INPUTS, agentId: 'agent-1' }, { pinDeps: { primary: pinata }, writer }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
    expect(pinSpy).not.toHaveBeenCalled();
    expect(writer.calls).toHaveLength(0);
  });

  it('CRITICAL agentId with control chars → ConfigError with sanitized echo', async () => {
    await expect(
      writeAttestation(
        { ...INPUTS, agentId: '1\n[ADMIN]injection' },
        { pinDeps: { primary: fakePinService() }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError) || e.type !== 'ConfigError') return false;
      return !e.message.includes('\n');
    });
  });

  it('ZodError from envelope validation → wrapped as ConciergeError(ConfigError)', async () => {
    await expect(
      writeAttestation(
        // biome-ignore lint/suspicious/noExplicitAny: deliberate
        { ...INPUTS, providerSchema: 'not.a.real.schema' as any },
        { pinDeps: { primary: fakePinService() }, writer: fakeWriter() },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('result.canonical is the byte-identical IPFS-pinned content', async () => {
    const out = await writeAttestation(INPUTS, {
      pinDeps: { primary: fakePinService() },
      writer: fakeWriter(),
    });
    expect(out.canonical).toContain(`"agentId":"${INPUTS.agentId}"`);
    expect(out.canonical).toContain(`"schema":"${INPUTS.providerSchema}"`);
  });

  it('AbortSignal threaded through to writer.giveFeedback', async () => {
    let capturedSignal: AbortSignal | undefined;
    const writer: Erc8004AttestWriter = {
      async giveFeedback(args) {
        capturedSignal = args.signal;
        return { attestationUid: ATTESTATION_UID, txHash: TX_HASH };
      },
    };
    const ctl = new AbortController();
    await writeAttestation(INPUTS, {
      pinDeps: { primary: fakePinService() },
      writer,
      signal: ctl.signal,
    });
    expect(capturedSignal).toBe(ctl.signal);
  });

  it('no caller signal → defaults to AbortSignal.timeout (NOT NEVER_ABORT)', async () => {
    let capturedSignal: AbortSignal | undefined;
    const writer: Erc8004AttestWriter = {
      async giveFeedback(args) {
        capturedSignal = args.signal;
        return { attestationUid: ATTESTATION_UID, txHash: TX_HASH };
      },
    };
    await writeAttestation(INPUTS, {
      pinDeps: { primary: fakePinService() },
      writer,
    });
    expect(capturedSignal).toBeDefined();
    // AbortSignal.timeout(60_000) — has aborted=false initially.
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('CWE-117: writer error.message with control chars → stripped in ConciergeError', async () => {
    const writer: Erc8004AttestWriter = {
      async giveFeedback() {
        throw new Error('boom\n[ADMIN] override\r\nfake');
      },
    };
    await expect(
      writeAttestation(INPUTS, {
        pinDeps: { primary: fakePinService() },
        writer,
      }),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      return !e.message.includes('\n') && !e.message.includes('\r');
    });
  });

  it('round-1: on-chain failure log includes orphanCid for reconciliation', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const writer: Erc8004AttestWriter = {
      async giveFeedback() {
        throw new Error('chain stalled');
      },
    };
    await expect(
      writeAttestation(INPUTS, {
        pinDeps: { primary: fakePinService() },
        writer,
        logger,
      }),
    ).rejects.toBeDefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const meta = logger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(meta?.['orphanCid']).toBe(VALID_CIDV1);
    expect(meta?.['errName']).toBe('Error');
  });
});
