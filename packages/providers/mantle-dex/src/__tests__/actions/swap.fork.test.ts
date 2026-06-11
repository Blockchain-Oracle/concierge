// Fork integration tests for the swap action — requires Anvil + Mantle Mainnet fork.
// Tokens are seeded via anvil_setStorageAt (no real swap needed to acquire test balance).
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMantleDexProvider } from '../../provider.ts';
import { type AnvilFork, startAnvilFork, TEST_ACCOUNT, TOKEN_BALANCE_SLOTS } from '../setup.ts';

const USDC = ADDRESSES.mantleMainnet.tokens.USDC;
const USDe = ADDRESSES.mantleMainnet.tokens.USDe;

// 100 USDC (6 decimals)
const USDC_AMOUNT = 100_000_000n;
// Generous seed: 500 USDC
const SEED_USDC = 500_000_000n;

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();

  // Seed test account with USDC via direct storage write — faster than a real swap.
  const usdcSlot = TOKEN_BALANCE_SLOTS[USDC.toLowerCase()];
  if (usdcSlot === undefined) throw new Error('USDC balance slot not configured');
  await fork.setErc20Balance(USDC, TEST_ACCOUNT, SEED_USDC, usdcSlot);
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

function makeProvider() {
  const publicClient = createPublicClient({
    chain: fork.chain,
    transport: http(`http://127.0.0.1:${fork.port}`),
  });
  return createMantleDexProvider({
    publicClient,
    walletClient: fork.walletClient,
    chain: 'mantle-mainnet',
  });
}

describe('swap action — fork integration', () => {
  it('seeded USDC balance is readable after anvil_setStorageAt', async () => {
    const balance = await fork.publicClient.readContract({
      address: USDC,
      abi: [
        {
          name: 'balanceOf',
          type: 'function',
          inputs: [{ name: '', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'balanceOf',
      args: [TEST_ACCOUNT],
    });
    expect(balance).toBeGreaterThanOrEqual(SEED_USDC);
  }, 30_000);

  it('happy path: USDC → USDe swap succeeds and increases USDe balance', async () => {
    const provider = makeProvider();

    const usdeBefore = await fork.publicClient.readContract({
      address: USDe,
      abi: [
        {
          name: 'balanceOf',
          type: 'function',
          inputs: [{ name: '', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'balanceOf',
      args: [TEST_ACCOUNT],
    });

    const result = await provider.actions.swap.invoke({
      tokenIn: USDC,
      tokenOut: USDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 100, // 1% — wide enough to tolerate fork state
      recipient: TEST_ACCOUNT,
    });

    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(result.venue).toMatch(/^(merchantMoe|agni|fusionx|woofi|lifi)$/);
    expect(BigInt(result.amountOut)).toBeGreaterThan(0n);

    // USDe balance must have increased
    const usdeAfter = await fork.publicClient.readContract({
      address: USDe,
      abi: [
        {
          name: 'balanceOf',
          type: 'function',
          inputs: [{ name: '', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'balanceOf',
      args: [TEST_ACCOUNT],
    });
    expect(usdeAfter).toBeGreaterThan(usdeBefore);

    // Attestation payload must include expected fields
    expect(result.attestationPayload.venue).toBe(result.venue);
    expect(result.attestationPayload.amountIn).toBe(USDC_AMOUNT.toString());
    expect(result.attestationPayload.txHash).toBe(result.txHash);
  }, 120_000);

  it('SwapSlippageBreach: extremely tight slippage throws before any tx', async () => {
    const provider = makeProvider();

    const txCountBefore = await fork.publicClient.getTransactionCount({
      address: TEST_ACCOUNT,
    });

    await expect(
      provider.actions.swap.invoke({
        tokenIn: USDC,
        tokenOut: USDe,
        amountIn: USDC_AMOUNT,
        slippageBps: 1, // 0.01% — will breach on any real spread
        recipient: TEST_ACCOUNT,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'SwapSlippageBreach',
    );

    // No new txs should have been submitted — breach is pre-flight
    const txCountAfter = await fork.publicClient.getTransactionCount({
      address: TEST_ACCOUNT,
    });
    expect(txCountAfter).toBe(txCountBefore);
  }, 60_000);
});
