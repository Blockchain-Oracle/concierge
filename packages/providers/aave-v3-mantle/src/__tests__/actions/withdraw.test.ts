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
} from '../setup.ts';

const poolAbi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
]);

let anvil: AnvilInstance;
let mocks: MockAddresses;

async function makeWithdrawer(anvilAccountIdx: number, withDebt = false) {
  const addr = ANVIL_ACCOUNTS[anvilAccountIdx] as Address;
  const { walletClient, publicClient, chain } = anvil;

  await mintToken(anvil, mocks.usdc, addr, 500_000_000n);
  await walletClient.writeContract({
    address: mocks.usdc,
    abi: erc20Abi,
    functionName: 'approve',
    args: [mocks.pool, 2n ** 256n - 1n],
    account: addr,
    chain,
  });
  await walletClient.writeContract({
    address: mocks.pool,
    abi: poolAbi,
    functionName: 'supply',
    args: [mocks.usdc, 200_000_000n, addr, 0],
    account: addr,
    chain,
  });

  if (withDebt) {
    // Borrow 140 USDC → HF = (200 × 0.80) / 140 ≈ 1.14 < 1.5
    await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'borrow',
      args: [mocks.usdc, 140_000_000n, 2n, 0, addr],
      account: addr,
      chain,
    });
  }

  const wc = createWalletClient({
    transport: http(`http://127.0.0.1:${anvil.port}`),
    account: addr, // Anvil unlocked account
  });
  return {
    provider: createAaveV3MantleProvider({
      walletClient: wc,
      publicClient,
      chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    }),
    addr,
  };
}

beforeAll(async () => {
  anvil = await startAnvil();
  mocks = await deployMocks(anvil);
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe('withdraw action', () => {
  it('throws InsufficientLiquidity when pre-withdraw HF < 1.5', async () => {
    const { ConciergeError } = await import('@concierge/sdk');
    const { provider, addr } = await makeWithdrawer(0, true); // HF ≈ 1.14

    const err = await provider.actions.withdraw
      .invoke({ asset: mocks.usdc, amount: '1000000', to: addr })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('InsufficientLiquidity');
  });

  it('clean withdraw: collateral decreases by withdrawn amount', async () => {
    const { provider, addr } = await makeWithdrawer(1, false); // no debt, HF = max

    const pre = await getUserAccountData(anvil.publicClient, mocks.pool, addr);
    expect(pre.totalCollateralBase).toBeGreaterThan(0n);

    const result = await provider.actions.withdraw.invoke({
      asset: mocks.usdc,
      amount: '50000000', // 50 USDC
      to: addr,
    });

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.withdraw.v1');

    const post = await getUserAccountData(anvil.publicClient, mocks.pool, addr);
    expect(post.totalCollateralBase).toBeLessThan(pre.totalCollateralBase);
  });

  it('amount=max with no debt: withdraws full aToken balance, collateral reaches zero', async () => {
    const { provider, addr } = await makeWithdrawer(3, false); // no debt

    const pre = await getUserAccountData(anvil.publicClient, mocks.pool, addr);
    expect(pre.totalCollateralBase).toBeGreaterThan(0n);

    const result = await provider.actions.withdraw.invoke({
      asset: mocks.usdc,
      amount: 'max',
      to: addr,
    });

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.withdraw.v1');
    expect(result.warning).toBeUndefined();

    const post = await getUserAccountData(anvil.publicClient, mocks.pool, addr);
    expect(post.totalCollateralBase).toBe(0n);
  });

  it('throws InsufficientLiquidity for amount=max when debt is outstanding', async () => {
    const { ConciergeError } = await import('@concierge/sdk');
    // Small borrow keeps HF > 1.5, but max withdraw should still be rejected
    const addr = ANVIL_ACCOUNTS[2] as Address;
    const { walletClient, publicClient, chain } = anvil;

    await mintToken(anvil, mocks.usdc, addr, 500_000_000n);
    await walletClient.writeContract({
      address: mocks.usdc,
      abi: erc20Abi,
      functionName: 'approve',
      args: [mocks.pool, 2n ** 256n - 1n],
      account: addr,
      chain,
    });
    await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'supply',
      args: [mocks.usdc, 200_000_000n, addr, 0],
      account: addr,
      chain,
    });
    // Borrow small amount (HF = (200 × 0.80) / 10 = 16.0 > 1.5)
    await walletClient.writeContract({
      address: mocks.pool,
      abi: poolAbi,
      functionName: 'borrow',
      args: [mocks.usdc, 10_000_000n, 2n, 0, addr],
      account: addr,
      chain,
    });

    const wc = createWalletClient({
      transport: http(`http://127.0.0.1:${anvil.port}`),
      account: addr,
    });
    const p = createAaveV3MantleProvider({
      walletClient: wc,
      publicClient,
      chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    });

    const err = await p.actions.withdraw
      .invoke({ asset: mocks.usdc, amount: 'max', to: addr })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('InsufficientLiquidity');
  });
});
