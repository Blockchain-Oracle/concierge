import type { Address } from '@concierge/shared';
import { parseAbi } from 'viem';
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

// Each test gets a different Anvil account to avoid state interference.
// Anvil accounts #1-#7 are all pre-funded and unlocked for eth_sendTransaction.
async function setupBorrower(anvilAccountIdx: number) {
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
    args: [mocks.usdc, 300_000_000n, addr, 0],
    account: addr,
    chain,
  });
  await walletClient.writeContract({
    address: mocks.pool,
    abi: poolAbi,
    functionName: 'borrow',
    args: [mocks.usdc, 100_000_000n, 2n, 0, addr],
    account: addr,
    chain,
  });

  const { createWalletClient, http } = await import('viem');
  // Use the Anvil account address directly — Anvil has it unlocked for eth_sendTransaction.
  const wc = createWalletClient({
    transport: http(`http://127.0.0.1:${anvil.port}`),
    account: addr, // JSON-RPC account — Anvil unlocked
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

describe('repay action', () => {
  it('partial repay: debt decreases by repaid amount', async () => {
    const { provider, addr } = await setupBorrower(0); // ANVIL_ACCOUNTS[0]

    const pre = await getUserAccountData(anvil.publicClient, mocks.pool, addr);

    const result = await provider.actions.repay.invoke({
      asset: mocks.usdc,
      amount: '50000000', // 50 USDC
    });

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.repay.v1');
    // Verify event-log parser returned the actual repaid amount (not 0 or maxUint256)
    expect(BigInt(result.actualRepaid)).toBe(50_000_000n);

    const post = await getUserAccountData(anvil.publicClient, mocks.pool, addr);
    expect(post.totalDebtBase).toBeLessThan(pre.totalDebtBase);
  });

  it('amount=max: debt is fully cleared', async () => {
    const { provider, addr } = await setupBorrower(1);

    const result = await provider.actions.repay.invoke({
      asset: mocks.usdc,
      amount: 'max',
    });

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const post = await getUserAccountData(anvil.publicClient, mocks.pool, addr);
    expect(post.totalDebtBase).toBe(0n);
  });

  it('max repay: actualRepaid is the debt amount, not maxUint256', async () => {
    const { provider } = await setupBorrower(2);

    const result = await provider.actions.repay.invoke({
      asset: mocks.usdc,
      amount: 'max',
    });

    // actualRepaid should be ~100 USDC (not maxUint256 = 1.15e77)
    const actualRepaid = BigInt(result.actualRepaid);
    expect(actualRepaid).toBeGreaterThan(0n);
    expect(actualRepaid).toBeLessThan(200_000_000n);
  });

  it('attestation schema is correct and payload validates', async () => {
    const { AttestationPayloadSchema } = await import('../../attestation.ts');
    const { provider } = await setupBorrower(3);

    const result = await provider.actions.repay.invoke({
      asset: mocks.usdc,
      amount: '30000000',
    });

    const parsed = AttestationPayloadSchema.safeParse(result.attestationPayload);
    expect(parsed.success).toBe(true);
    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.repay.v1');
  });
});
