// The E-Mode silent-fail-trap test is the most important assertion in this test suite.
// See: research/concierge/03-providers/aave-v3-mantle.md § Load-bearing gotchas
// The Aave pool silently returns 0 when sUSDe LTV=0 (no E-Mode). We detect it client-side.

import type { Address } from '@concierge/shared';
import { createWalletClient, http, parseAbi } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAaveV3MantleProvider } from '../../provider.ts';
import { getUserAccountData } from '../../selectors.ts';
import {
  ANVIL_ACCOUNTS,
  type AnvilInstance,
  deployMocks,
  type MockAddresses,
  mintToken,
  startAnvil,
  TEST_ACCOUNT,
} from '../setup.ts';

const poolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

let anvil: AnvilInstance;
let mocks: MockAddresses;
let provider: ReturnType<typeof createAaveV3MantleProvider>;

beforeAll(async () => {
  anvil = await startAnvil();
  mocks = await deployMocks(anvil);

  provider = createAaveV3MantleProvider({
    walletClient: anvil.walletClient,
    publicClient: anvil.publicClient,
    chain: anvil.chain,
    addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
  });
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe('borrow — E-Mode silent-fail trap', () => {
  it('throws EModeNotEnabled BEFORE submitting tx when user has aSUSDe but no E-Mode', async () => {
    const { ConciergeError } = await import('@concierge/sdk');

    // Directly mint aSUSDe to TEST_ACCOUNT to simulate having supplied sUSDe.
    // aSUSDe balance > 0 triggers the preflight guard in borrow.ts.
    await mintToken(anvil, mocks.aSUsde, TEST_ACCOUNT, 100n * 10n ** 18n);

    // Supply USDC so TEST_ACCOUNT has collateral (prevents a different revert if preflight skips).
    // Await receipts explicitly so txCountBefore is a stable snapshot of mined txs — if approve
    // or supply is still in Anvil's mempool when txCountBefore is read, Anvil may mine them while
    // borrow.invoke runs, making txCountAfter > txCountBefore even though no borrow tx fired.
    const approveHash = await anvil.walletClient.writeContract({
      address: mocks.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [mocks.pool, 2n ** 256n - 1n],
      account: TEST_ACCOUNT,
      chain: anvil.chain,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: approveHash });
    const supplyHash = await anvil.walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'supply',
      args: [mocks.usdc, 200_000_000n, TEST_ACCOUNT, 0],
      account: TEST_ACCOUNT,
      chain: anvil.chain,
    });
    await anvil.publicClient.waitForTransactionReceipt({ hash: supplyHash });

    // Count txs before the call to verify no new tx is submitted after the throw.
    const txCountBefore = await anvil.publicClient.getTransactionCount({
      address: TEST_ACCOUNT,
    });

    const err = await provider.actions.borrow
      .invoke({ asset: mocks.usdc, amount: '50000000' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('EModeNotEnabled');

    // Critical: no tx submitted to chain — the guard fires before pool.borrow()
    const txCountAfter = await anvil.publicClient.getTransactionCount({
      address: TEST_ACCOUNT,
    });
    expect(txCountAfter).toBe(txCountBefore);
  });
});

describe('borrow — happy path with E-Mode', () => {
  it('supply sUSDe → setUserEMode(1) → borrow USDC with eMode=1 in attestation', async () => {
    // Use Anvil account #1 (unlocked on the node)
    const borrowerAddr = ANVIL_ACCOUNTS[0] as Address;
    const { walletClient, publicClient, chain } = anvil;

    // Mint sUSDe (underlying) and aSUSDe (aToken) to borrower
    await mintToken(anvil, mocks.sUsde, borrowerAddr, 200n * 10n ** 18n);
    await mintToken(anvil, mocks.aSUsde, borrowerAddr, 200n * 10n ** 18n);

    // Supply sUSDe into pool (updates _supplies for collateral computation)
    const sUsdeApproveHash = await walletClient.writeContract({
      address: mocks.sUsde,
      abi: erc20Abi,
      functionName: 'approve',
      args: [mocks.pool, 2n ** 256n - 1n],
      account: borrowerAddr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: sUsdeApproveHash });
    const sUsdeSupplyHash = await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'supply',
      args: [mocks.sUsde, 200n * 10n ** 18n, borrowerAddr, 0],
      account: borrowerAddr,
      chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: sUsdeSupplyHash });

    // Create provider for the borrower (using Anvil's unlocked account)
    const borrowerWC = createWalletClient({
      transport: http(`http://127.0.0.1:${anvil.port}`),
      account: borrowerAddr, // JSON-RPC account — Anvil has it unlocked
    });
    const borrowerProvider = createAaveV3MantleProvider({
      walletClient: borrowerWC,
      publicClient,
      chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    });

    // setUserEMode(1) — enables E-Mode 1 (sUSDe / stablecoins, LTV=92%)
    await borrowerProvider.actions.setUserEMode.invoke({ categoryId: 1 });

    // Borrow 50 USDC — should succeed, eMode=1 passes preflight
    const result = await borrowerProvider.actions.borrow.invoke({
      asset: mocks.usdc,
      amount: '50000000', // 50 USDC
    });

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.borrow.v1');
    expect(result.attestationPayload.eMode).toBe(1);

    // HF > 1.5 after borrow; postHF must be strictly less than preHF
    const hfBig = BigInt(result.attestationPayload.postHF);
    const preHF = BigInt(result.attestationPayload.preHF);
    expect(hfBig).toBeGreaterThan(1_500_000_000_000_000_000n);
    expect(preHF).toBeGreaterThan(hfBig);

    // Debt position actually registered on-chain
    const postAccountData = await getUserAccountData(publicClient, mocks.pool, borrowerAddr);
    expect(postAccountData.totalDebtBase).toBeGreaterThan(0n);
  });

  it('throws RpcError when borrow exceeds available collateral', async () => {
    const { ConciergeError } = await import('@concierge/sdk');
    // Use Anvil account #2 — no aSUsde balance, so EModeNotEnabled guard won't fire.
    // Supply a small amount of USDC, then attempt an impossibly large borrow → RpcError.
    const addr = ANVIL_ACCOUNTS[1] as Address;
    await mintToken(anvil, mocks.usdc, addr, 100_000_000n);
    await anvil.walletClient.writeContract({
      address: mocks.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [mocks.pool, 2n ** 256n - 1n],
      account: addr,
      chain: anvil.chain,
    });
    await anvil.walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'supply',
      args: [mocks.usdc, 100_000_000n, addr, 0],
      account: addr,
      chain: anvil.chain,
    });

    const wc = createWalletClient({
      transport: http(`http://127.0.0.1:${anvil.port}`),
      account: addr,
    });
    const p = createAaveV3MantleProvider({
      walletClient: wc,
      publicClient: anvil.publicClient,
      chain: anvil.chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    });

    const err = await p.actions.borrow
      .invoke({ asset: mocks.usdc, amount: '10000000000000' }) // 10B USDC — far exceeds collateral
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('RpcError');
  });
});
