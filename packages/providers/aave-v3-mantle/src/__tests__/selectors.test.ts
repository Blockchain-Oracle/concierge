import type { Address } from '@concierge/shared';
import { parseAbi } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getUserAccountData, getUserEMode, maxSafeBorrow } from '../selectors.ts';
import {
  ANVIL_ACCOUNTS,
  type AnvilInstance,
  deployMocks,
  type MockAddresses,
  mintToken,
  startAnvil,
  TEST_ACCOUNT,
} from './setup.ts';

const poolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

let anvil: AnvilInstance;
let mocks: MockAddresses;

beforeAll(async () => {
  anvil = await startAnvil();
  mocks = await deployMocks(anvil);
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe('getUserAccountData', () => {
  it('returns zeroes for a fresh account with no positions', async () => {
    const data = await getUserAccountData(anvil.publicClient, mocks.pool, TEST_ACCOUNT);
    expect(data.totalCollateralBase).toBe(0n);
    expect(data.totalDebtBase).toBe(0n);
    expect(data.healthFactor).toBeGreaterThan(0n);
  });

  it('HF fixture: $200 collateral at LT=80% / $100 debt → HF ≈ 1.6', async () => {
    // Use Anvil account #1 for isolation
    const addr = ANVIL_ACCOUNTS[0] as Address;
    const { walletClient, publicClient, chain } = anvil;

    await mintToken(anvil, mocks.usdc, addr, 200_000_000n);
    const hfApproveHash = await walletClient.writeContract({
      address: mocks.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [mocks.pool, 2n ** 256n - 1n],
      account: addr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: hfApproveHash });
    const hfSupplyHash = await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'supply',
      args: [mocks.usdc, 200_000_000n, addr, 0],
      account: addr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: hfSupplyHash });
    const hfBorrowHash = await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'borrow',
      args: [mocks.usdc, 100_000_000n, 2n, 0, addr],
      account: addr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: hfBorrowHash });

    const data = await getUserAccountData(publicClient, mocks.pool, addr);
    // HF = (collateral × LT / 10000) / debt = 200e8 × 8000 / 10000 / 100e8 = 1.6
    const HF_EXPECTED = 1_600_000_000_000_000_000n;
    const TOLERANCE = 20_000_000_000_000_000n; // 2%
    expect(data.healthFactor).toBeGreaterThan(HF_EXPECTED - TOLERANCE);
    expect(data.healthFactor).toBeLessThan(HF_EXPECTED + TOLERANCE);
  });
});

describe('getUserEMode', () => {
  it('returns 0 by default', async () => {
    const eMode = await getUserEMode(anvil.publicClient, mocks.pool, TEST_ACCOUNT);
    expect(eMode).toBe(0);
  });
});

describe('maxSafeBorrow', () => {
  it('returns 0 when no collateral', async () => {
    const result = await maxSafeBorrow({
      publicClient: anvil.publicClient,
      poolAddress: mocks.pool,
      user: TEST_ACCOUNT,
      assetPrice: 1_00_000_000n,
      assetDecimals: 6,
      targetHF: 1.5,
    });
    expect(result).toBe(0n);
  });

  it('computes borrow amount that produces HF≈targetHF (reverse-verify)', async () => {
    const addr = ANVIL_ACCOUNTS[1] as Address;
    const { walletClient, publicClient, chain } = anvil;

    await mintToken(anvil, mocks.usdc, addr, 300_000_000n);
    const msApproveHash = await walletClient.writeContract({
      address: mocks.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [mocks.pool, 2n ** 256n - 1n],
      account: addr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: msApproveHash });
    const msSupplyHash = await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'supply',
      args: [mocks.usdc, 300_000_000n, addr, 0],
      account: addr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: msSupplyHash });

    const safeBorrow = await maxSafeBorrow({
      publicClient,
      poolAddress: mocks.pool,
      user: addr,
      assetPrice: 1_00_000_000n,
      assetDecimals: 6,
      targetHF: 1.5,
    });

    expect(safeBorrow).toBeGreaterThan(0n);

    // Borrow the computed amount and verify HF ≥ 1.4 (≈1.5 ± 5% due to integer truncation).
    // Explicitly await the receipt so CI runners don't read state before the block mines.
    const borrowHash = await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'borrow',
      args: [mocks.usdc, safeBorrow, 2n, 0, addr],
      account: addr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: borrowHash });
    const data = await getUserAccountData(publicClient, mocks.pool, addr);
    expect(data.healthFactor).toBeGreaterThanOrEqual(1_400_000_000_000_000_000n);
    expect(data.healthFactor).toBeLessThanOrEqual(1_600_000_000_000_000_000n);
  });
});
