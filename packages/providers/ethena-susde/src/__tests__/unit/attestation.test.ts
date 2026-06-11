import { describe, expect, it } from 'vitest';
import {
  AttestationPayloadSchema,
  buildAttestationPayload,
  ETHENA_ATTESTATION_SCHEMAS,
} from '../../attestation.ts';

const USDE = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' as const;
const SUSDE = '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2' as const;
const TX = `0x${'ab'.repeat(32)}` as const;

describe('buildAttestationPayload', () => {
  it('builds a wrap payload with correct schema and stringified amounts', () => {
    const payload = buildAttestationPayload({
      action: 'wrap',
      chainId: 5000,
      tokenIn: USDE,
      tokenOut: SUSDE,
      amountIn: 1_000_000_000_000_000_000n,
      amountOut: 950_000_000_000_000_000n,
      txHash: TX,
    });

    expect(payload.schema).toBe(ETHENA_ATTESTATION_SCHEMAS.wrap);
    expect(payload.chain).toBe(5000);
    expect(payload.tokenIn).toBe(USDE);
    expect(payload.tokenOut).toBe(SUSDE);
    expect(payload.amountIn).toBe('1000000000000000000');
    expect(payload.amountOut).toBe('950000000000000000');
    expect(payload.txHash).toBe(TX);
    expect(payload.ts).toBeGreaterThan(0);
  });

  it('builds an unwrap payload with unwrap schema', () => {
    const payload = buildAttestationPayload({
      action: 'unwrap',
      chainId: 5000,
      tokenIn: SUSDE,
      tokenOut: USDE,
      amountIn: 1_000_000_000_000_000_000n,
      amountOut: 1_050_000_000_000_000_000n,
      txHash: TX,
    });
    expect(payload.schema).toBe(ETHENA_ATTESTATION_SCHEMAS.unwrap);
  });
});

describe('AttestationPayloadSchema', () => {
  const VALID = {
    schema: ETHENA_ATTESTATION_SCHEMAS.wrap,
    chain: 5000,
    tokenIn: USDE,
    tokenOut: SUSDE,
    amountIn: '1000000000000000000',
    amountOut: '950000000000000000',
    txHash: TX,
    ts: 1_718_000_000,
  };

  it('accepts a valid wrap payload', () => {
    expect(AttestationPayloadSchema.safeParse(VALID).success).toBe(true);
  });

  it('rejects a zero-address tokenIn', () => {
    const result = AttestationPayloadSchema.safeParse({
      ...VALID,
      tokenIn: '0x0000000000000000000000000000000000000000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed txHash', () => {
    const result = AttestationPayloadSchema.safeParse({ ...VALID, txHash: '0xdeadbeef' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer amount string', () => {
    const result = AttestationPayloadSchema.safeParse({ ...VALID, amountIn: '1.5e18' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown schema value', () => {
    const result = AttestationPayloadSchema.safeParse({ ...VALID, schema: 'concierge.bad.v1' });
    expect(result.success).toBe(false);
  });
});
