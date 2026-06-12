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
