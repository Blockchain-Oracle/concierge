// Fork integration tests for getCarryVsAave — reads real Aave USDC borrow rate from
// a Mantle Mainnet fork; stubs the Ethena API for deterministic carry math.
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { createPublicClient, http } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEthenaSusdeProvider } from '../../provider.ts';
import { type AnvilFork, startAnvilFork, stubEthenaApi } from '../setup.ts';

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeProvider() {
  return createEthenaSusdeProvider({
    publicClient: createPublicClient({
      chain: fork.chain,
      transport: http(`http://127.0.0.1:${fork.port}`),
    }),
    chain: fork.chain,
    addresses: {
      usde: ADDRESSES.mantleMainnet.tokens.USDe,
      susde: ADDRESSES.mantleMainnet.tokens.sUSDe,
      usdc: ADDRESSES.mantleMainnet.tokens.USDC,
      aavePool: ADDRESSES.mantleMainnet.aave.pool,
      aaveOracle: ADDRESSES.mantleMainnet.aave.oracle,
      woofiRouter: ADDRESSES.mantleMainnet.mantleDex.woofi.router,
    },
  });
}

describe('getCarryVsAave — fork', () => {
  it('reads real Aave USDC borrow rate and computes carry against stubbed sUSDe yield', async () => {
    stubEthenaApi(3.8); // 380 bps
    const result = await makeProvider().actions.getCarryVsAave.invoke({ spreadFloor: 0 });
    expect(result.susdeYieldBps).toBe(380);
    expect(result.usdcBorrowBps).toBeGreaterThanOrEqual(0);
    expect(result.carryBps).toBe(result.susdeYieldBps - result.usdcBorrowBps);
    expect(typeof result.spreadFloorPassing).toBe('boolean');
  }, 30_000);

  it('spreadFloor=99999 forces spreadFloorPassing=false regardless of real rates', async () => {
    stubEthenaApi(5.0);
    const result = await makeProvider().actions.getCarryVsAave.invoke({ spreadFloor: 99999 });
    expect(result.spreadFloorPassing).toBe(false);
  }, 30_000);

  it('throws RpcError when Aave pool contract is drained', async () => {
    stubEthenaApi(3.8);
    await fork.drainContract(ADDRESSES.mantleMainnet.aave.pool);
    await expect(
      makeProvider().actions.getCarryVsAave.invoke({ spreadFloor: 0 }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  }, 30_000);
});
