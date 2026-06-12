import { describe, expect, it } from 'vitest';
import { hashActionPayload } from '../eip712.ts';

const AGENT_ID = 42n;
const CHAIN_ID = 5000 as const;
const BASE_PAYLOAD = {
  schema: 'concierge.aave.v3.borrow.v1',
  preHF: '1.5',
  postHF: '1.4',
  amount: '1000000',
};

describe('hashActionPayload — determinism', () => {
  it('returns a 32-byte hex hash', () => {
    const hash = hashActionPayload(BASE_PAYLOAD, AGENT_ID, CHAIN_ID);
    expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('same payload always produces same hash (deterministic across calls)', () => {
    const h1 = hashActionPayload(BASE_PAYLOAD, AGENT_ID, CHAIN_ID);
    const h2 = hashActionPayload(BASE_PAYLOAD, AGENT_ID, CHAIN_ID);
    expect(h1).toBe(h2);
  });

  it('object key order does NOT affect the hash', () => {
    const payloadA = { schema: 'concierge.aave.v3.borrow.v1', amount: '1000000', preHF: '1.5' };
    const payloadB = { preHF: '1.5', schema: 'concierge.aave.v3.borrow.v1', amount: '1000000' };
    expect(hashActionPayload(payloadA, AGENT_ID, CHAIN_ID)).toBe(
      hashActionPayload(payloadB, AGENT_ID, CHAIN_ID),
    );
  });

  it('different agentId produces different hash', () => {
    const h1 = hashActionPayload(BASE_PAYLOAD, 1n, CHAIN_ID);
    const h2 = hashActionPayload(BASE_PAYLOAD, 2n, CHAIN_ID);
    expect(h1).not.toBe(h2);
  });

  it('different schema produces different hash', () => {
    const h1 = hashActionPayload(
      { ...BASE_PAYLOAD, schema: 'concierge.aave.v3.borrow.v1' },
      AGENT_ID,
      CHAIN_ID,
    );
    const h2 = hashActionPayload(
      { ...BASE_PAYLOAD, schema: 'concierge.aave.v3.supply.v1' },
      AGENT_ID,
      CHAIN_ID,
    );
    expect(h1).not.toBe(h2);
  });

  it('different chainId produces different hash', () => {
    const h1 = hashActionPayload(BASE_PAYLOAD, AGENT_ID, 5000);
    const h2 = hashActionPayload(BASE_PAYLOAD, AGENT_ID, 5003);
    expect(h1).not.toBe(h2);
  });

  it('different payload field values produce different hash', () => {
    const h1 = hashActionPayload({ ...BASE_PAYLOAD, amount: '1000000' }, AGENT_ID, CHAIN_ID);
    const h2 = hashActionPayload({ ...BASE_PAYLOAD, amount: '2000000' }, AGENT_ID, CHAIN_ID);
    expect(h1).not.toBe(h2);
  });
});

describe('hashActionPayload — domain regression guard', () => {
  // Pinned against the EIP-712 domain (name='Concierge', version='1') and ActionAttestation
  // type struct. If this test fails, the domain or type definition changed and all on-chain
  // feedbackHash values computed before the change are now unverifiable.
  it('produces a stable known hash for a fixed payload (domain pin)', () => {
    const PINNED = '0x4eee52942f4eb04c18df81dfa6fca65e04ac32d4f6150dbfe40f5aab39823a57';
    expect(
      hashActionPayload({ schema: 'concierge.aave.v3.borrow.v1', amount: '1000000' }, 42n, 5000),
    ).toBe(PINNED);
  });
});

describe('hashActionPayload — payload serialization', () => {
  it('array-valued fields are hashed deterministically (recursion guard)', () => {
    const p1 = { schema: 'concierge.aave.v3.borrow.v1', tokens: ['USDC', 'ETH'] };
    const h1 = hashActionPayload(p1, AGENT_ID, CHAIN_ID);
    const h2 = hashActionPayload(p1, AGENT_ID, CHAIN_ID);
    expect(h1).toBe(h2);
    // Array order IS significant — different order must produce a different hash
    const p2 = { schema: 'concierge.aave.v3.borrow.v1', tokens: ['ETH', 'USDC'] };
    expect(hashActionPayload(p2, AGENT_ID, CHAIN_ID)).not.toBe(h1);
  });

  it('BigInt-valued fields are serialized without throwing', () => {
    const p = { schema: 'concierge.aave.v3.borrow.v1', amount: 1_000_000n };
    expect(() =>
      hashActionPayload(
        p as unknown as Record<string, unknown> & { schema: string },
        AGENT_ID,
        CHAIN_ID,
      ),
    ).not.toThrow();
  });
});

describe('hashActionPayload — non-serializable payload guards', () => {
  it('throws TypeError when payload contains an undefined field', () => {
    expect(() =>
      hashActionPayload(
        { schema: 'x', val: undefined } as unknown as Record<string, unknown> & { schema: string },
        AGENT_ID,
        CHAIN_ID,
      ),
    ).toThrow(TypeError);
  });

  it('throws TypeError when payload contains a Date object', () => {
    expect(() =>
      hashActionPayload(
        { schema: 'x', val: new Date() } as unknown as Record<string, unknown> & { schema: string },
        AGENT_ID,
        CHAIN_ID,
      ),
    ).toThrow(TypeError);
  });

  it('throws TypeError when payload contains a Map', () => {
    expect(() =>
      hashActionPayload(
        { schema: 'x', val: new Map() } as unknown as Record<string, unknown> & { schema: string },
        AGENT_ID,
        CHAIN_ID,
      ),
    ).toThrow(TypeError);
  });
});
