import { describe, expect, it } from 'vitest';
import type { AaveAction, AttestationContext } from '../attestation.ts';
import {
  AAVE_ATTESTATION_SCHEMAS,
  AttestationPayloadSchema,
  buildAttestationPayload,
} from '../attestation.ts';

const ALL_ACTIONS: AaveAction[] = [
  'supply',
  'borrow',
  'repay',
  'withdraw',
  'setUserEMode',
  'claimRewards',
];

const BASE_CTX: AttestationContext = {
  action: 'supply',
  chainId: 5000 as number & { _brand: 'EvmChainId' },
  pool: '0x1234567890123456789012345678901234567890',
  asset: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  amountBase: 1_000_000n,
  txHash: '0xdeadbeef',
  preHF: 2_000_000_000_000_000_000n,
  postHF: 1_800_000_000_000_000_000n,
  eMode: 0,
} as AttestationContext;

describe('AAVE_ATTESTATION_SCHEMAS', () => {
  it('maps each of the six actions to concierge.aave.v3.<action>.v1', () => {
    for (const action of ALL_ACTIONS) {
      const schema = AAVE_ATTESTATION_SCHEMAS[action];
      expect(schema).toBe(`concierge.aave.v3.${action}.v1`);
    }
  });

  it('schema strings match the canonical regex', () => {
    for (const schema of Object.values(AAVE_ATTESTATION_SCHEMAS)) {
      expect(schema).toMatch(/^concierge\.aave\.v3\.[a-zA-Z]+\.v1$/);
    }
  });

  it('has exactly six entries — one per action', () => {
    expect(Object.keys(AAVE_ATTESTATION_SCHEMAS)).toHaveLength(6);
  });
});

describe('buildAttestationPayload', () => {
  it('payload passes AttestationPayloadSchema validation for every action', () => {
    for (const action of ALL_ACTIONS) {
      const payload = buildAttestationPayload({ ...BASE_CTX, action });
      const result = AttestationPayloadSchema.safeParse(payload);
      expect(result.success, `${action} payload invalid: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('schema field equals the canonical value for each action', () => {
    for (const action of ALL_ACTIONS) {
      const payload = buildAttestationPayload({ ...BASE_CTX, action });
      expect(payload.schema).toBe(`concierge.aave.v3.${action}.v1`);
    }
  });

  it('bigint fields are serialised as decimal strings (not hex, not notation)', () => {
    const payload = buildAttestationPayload(BASE_CTX);
    expect(payload.amountBase).toBe('1000000');
    expect(payload.preHF).toBe('2000000000000000000');
    expect(payload.postHF).toBe('1800000000000000000');
    expect(payload.amountBase).toMatch(/^\d+$/);
  });

  it('eMode is preserved as a plain number', () => {
    const p0 = buildAttestationPayload({ ...BASE_CTX, eMode: 0 });
    const p1 = buildAttestationPayload({ ...BASE_CTX, eMode: 1 });
    expect(p0.eMode).toBe(0);
    expect(p1.eMode).toBe(1);
  });

  it('ts is within ±2s of current time', () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const payload = buildAttestationPayload(BASE_CTX);
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });
});
