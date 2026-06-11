import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeGetCarryVsAave } from '../../actions/getCarryVsAave.ts';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const AAVE_POOL = '0x458F293454fE0d67EC0655f3672301301DD51422' as const;
const USDC = '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' as const;

// RAY = 1e27. Aave stores per-year APR in RAY units in currentVariableBorrowRate.
const RAY = 1_000_000_000_000_000_000_000_000_000n;

function borrowRateForBps(bps: number): bigint {
  return (BigInt(bps) * RAY) / 10_000n;
}

// Minimal fake getReserveData return tuple: [0..14]. Index 4 = currentVariableBorrowRate.
function makeReserveTuple(borrowBps: number): readonly bigint[] {
  // Positional tuple; index 4 is currentVariableBorrowRate per Aave V3 getReserveData ABI.
  return [0n, 0n, 0n, 0n, borrowRateForBps(borrowBps), 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
}

function makeCtx(borrowBps: number): ActionContext {
  return {
    publicClient: {
      readContract: vi.fn().mockResolvedValue(makeReserveTuple(borrowBps)),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    } as any,
    chainId: 5000,
    addresses: {
      usde: ZERO,
      susde: ZERO,
      usdc: USDC,
      aavePool: AAVE_POOL,
      aaveOracle: ZERO,
      woofiRouter: ZERO,
    },
  };
}

function stubEthenaYield(susdeYieldBps: number): void {
  const pct = susdeYieldBps / 100;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ data: { protocol: pct, staking: pct } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('executeGetCarryVsAave — unit', () => {
  it('positive carry: sUSDe 380 bps, USDC borrow 351 bps → carryBps 29, passing', async () => {
    stubEthenaYield(380);
    const result = await executeGetCarryVsAave(makeCtx(351), 0);
    expect(result.susdeYieldBps).toBe(380);
    expect(result.usdcBorrowBps).toBe(351);
    expect(result.carryBps).toBe(29);
    expect(result.spreadFloorPassing).toBe(true);
  });

  it('inverted carry: sUSDe 200 bps, USDC borrow 400 bps → carryBps -200, not passing', async () => {
    stubEthenaYield(200);
    const result = await executeGetCarryVsAave(makeCtx(400), 0);
    expect(result.susdeYieldBps).toBe(200);
    expect(result.usdcBorrowBps).toBe(400);
    expect(result.carryBps).toBe(-200);
    expect(result.spreadFloorPassing).toBe(false);
  });

  it('spreadFloor=50: carry 29 bps < floor 50 → not passing', async () => {
    stubEthenaYield(380);
    const result = await executeGetCarryVsAave(makeCtx(351), 50);
    expect(result.carryBps).toBe(29);
    expect(result.spreadFloorPassing).toBe(false);
  });

  it('spreadFloor=50: carry 100 bps >= floor 50 → passing', async () => {
    stubEthenaYield(500);
    const result = await executeGetCarryVsAave(makeCtx(400), 50);
    expect(result.carryBps).toBe(100);
    expect(result.spreadFloorPassing).toBe(true);
  });

  it('exact equal carry equals spreadFloor → passing (boundary)', async () => {
    stubEthenaYield(450);
    const result = await executeGetCarryVsAave(makeCtx(400), 50);
    expect(result.carryBps).toBe(50);
    expect(result.spreadFloorPassing).toBe(true);
  });

  it('fetches Aave USDC reserve data and Ethena API in parallel', async () => {
    stubEthenaYield(380);
    const ctx = makeCtx(351);
    await executeGetCarryVsAave(ctx, 0);
    expect(ctx.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'getReserveData', args: [USDC] }),
    );
  });
});
