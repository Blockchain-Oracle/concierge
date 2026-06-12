import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { SCHEMA_NAMES, schemaIdFor } from '../schemas.ts';

describe('schemaIdFor — determinism and format', () => {
  it('returns a 32-byte hex string for known schemas', () => {
    for (const name of SCHEMA_NAMES) {
      const id = schemaIdFor(name);
      expect(id).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });

  it('is deterministic — same name always returns same id', () => {
    const name = 'concierge.aave.v3.borrow.v1';
    expect(schemaIdFor(name)).toBe(schemaIdFor(name));
  });

  it('matches raw keccak256(name) for a known schema', () => {
    const name = 'concierge.aave.v3.borrow.v1';
    const expected = keccak256(toBytes(name));
    expect(schemaIdFor(name)).toBe(expected);
  });

  it('different schema names produce different ids', () => {
    const id1 = schemaIdFor('concierge.aave.v3.borrow.v1');
    const id2 = schemaIdFor('concierge.aave.v3.supply.v1');
    expect(id1).not.toBe(id2);
  });

  it('accepts unknown schema names (returns computed keccak256)', () => {
    const custom = 'my.custom.schema.v1';
    const expected = keccak256(toBytes(custom));
    expect(schemaIdFor(custom)).toBe(expected);
  });

  it('pre-registers all expected Concierge schemas', () => {
    const expected = [
      'concierge.aave.v3.supply.v1',
      'concierge.aave.v3.borrow.v1',
      'concierge.aave.v3.repay.v1',
      'concierge.aave.v3.withdraw.v1',
      'concierge.aave.v3.setUserEMode.v1',
      'concierge.aave.v3.claimRewards.v1',
      'concierge.ethena.wrap.v1',
      'concierge.ethena.unwrap.v1',
      'concierge.lifi.bridge.sent.v1',
      'concierge.lifi.bridge.completed.v1',
    ];
    for (const s of expected) {
      expect(SCHEMA_NAMES).toContain(s);
      expect(schemaIdFor(s)).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });
});
