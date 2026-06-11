import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { assertHFAboveFloor } from '../actions/withdraw.ts';
import type { AttestationContext } from '../attestation.ts';
import { AAVE_ATTESTATION_SCHEMAS, buildAttestationPayload } from '../attestation.ts';
import type { UserAccountData } from '../selectors.ts';

function expectConciergeErrorType(fn: () => void, type: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConciergeError);
  expect((err as ConciergeError).type).toBe(type);
}

// ── assertHFAboveFloor ────────────────────────────────────────────────────────

const HF_FLOOR = 1_500_000_000_000_000_000n;
const ZERO_DEBT: UserAccountData = {
  totalCollateralBase: 1_000_000_000n,
  totalDebtBase: 0n,
  availableBorrowsBase: 0n,
  currentLiquidationThreshold: 8000n,
  ltv: 7500n,
  healthFactor: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
};
const HEALTHY: UserAccountData = {
  ...ZERO_DEBT,
  totalDebtBase: 100n,
  healthFactor: 2_000_000_000_000_000_000n,
};
const AT_FLOOR: UserAccountData = { ...ZERO_DEBT, totalDebtBase: 100n, healthFactor: HF_FLOOR };
const BELOW_FLOOR: UserAccountData = {
  ...ZERO_DEBT,
  totalDebtBase: 100n,
  healthFactor: HF_FLOOR - 1n,
};

describe('assertHFAboveFloor', () => {
  it('passes when no debt (max-uint HF sentinel)', () => {
    expect(() => assertHFAboveFloor(ZERO_DEBT, 100n)).not.toThrow();
    expect(() => assertHFAboveFloor(ZERO_DEBT, 'max')).not.toThrow();
  });

  it('passes when HF >= floor for explicit amount', () => {
    expect(() => assertHFAboveFloor(HEALTHY, 50n)).not.toThrow();
    expect(() => assertHFAboveFloor(AT_FLOOR, 50n)).not.toThrow();
  });

  it('throws InsufficientLiquidity when HF < floor for explicit amount', () => {
    expectConciergeErrorType(() => assertHFAboveFloor(BELOW_FLOOR, 50n), 'InsufficientLiquidity');
  });

  it('throws InsufficientLiquidity for amount=max with any debt (regardless of HF level)', () => {
    expectConciergeErrorType(() => assertHFAboveFloor(HEALTHY, 'max'), 'InsufficientLiquidity');
    expectConciergeErrorType(() => assertHFAboveFloor(BELOW_FLOOR, 'max'), 'InsufficientLiquidity');
  });
});

// ── buildAttestationPayload ───────────────────────────────────────────────────

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

describe('buildAttestationPayload', () => {
  it('maps each action to its canonical schema string', () => {
    for (const [action, schema] of Object.entries(AAVE_ATTESTATION_SCHEMAS)) {
      const payload = buildAttestationPayload({
        ...BASE_CTX,
        action: action as AttestationContext['action'],
      });
      expect(payload.schema).toBe(schema);
    }
  });

  it('serialises bigints as decimal strings', () => {
    const payload = buildAttestationPayload(BASE_CTX);
    expect(payload.amountBase).toBe('1000000');
    expect(payload.preHF).toBe('2000000000000000000');
    expect(payload.postHF).toBe('1800000000000000000');
  });

  it('serialises amountBase=0n as "0"', () => {
    const payload = buildAttestationPayload({ ...BASE_CTX, amountBase: 0n });
    expect(payload.amountBase).toBe('0');
  });

  it('ts is within ±2s of Date.now()/1000', () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const payload = buildAttestationPayload(BASE_CTX);
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });

  it('covers all six schema values with non-null strings', () => {
    for (const schema of Object.values(AAVE_ATTESTATION_SCHEMAS)) {
      expect(schema).toMatch(/^concierge\.aave\.v3\.[a-zA-Z]+\.v1$/);
    }
  });
});
