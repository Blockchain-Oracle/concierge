// Fork integration tests for the swap action — requires Anvil + Mantle Mainnet fork.
// Tokens are seeded via anvil_setStorageAt (no real swap needed to acquire test balance).
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { type Address, createPublicClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMantleDexProvider } from '../../provider.ts';
import { type AnvilFork, startAnvilFork, TEST_ACCOUNT, TOKEN_BALANCE_SLOTS } from '../setup.ts';

const USDC = ADDRESSES.mantleMainnet.tokens.USDC;
const USDe = ADDRESSES.mantleMainnet.tokens.USDe;

// 100 USDC (6 decimals)
const USDC_AMOUNT = 100_000_000n;
// Generous seed: 500 USDC
const SEED_USDC = 500_000_000n;

const BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();

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

async function getBalance(token: Address, account: Address): Promise<bigint> {
  return fork.publicClient.readContract({
    address: token,
    abi: BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [account],
  });
}

// Replaces contract bytecode with a single REVERT opcode — any call to that address reverts.
async function drainContract(addr: Address): Promise<void> {
  await fork.publicClient.request({
    // @ts-expect-error anvil_setCode is not in viem's standard type list
    method: 'anvil_setCode',
    params: [addr, '0xfd'],
  });
}

describe('swap action — fork integration', () => {
  it('seeded USDC balance is readable after anvil_setStorageAt', async () => {
    const balance = await getBalance(USDC, TEST_ACCOUNT);
    expect(balance).toBeGreaterThanOrEqual(SEED_USDC);
  }, 30_000);

  it('happy path: USDC → USDe swap succeeds and increases USDe balance', async () => {
    const provider = makeProvider();
    const usdeBefore = await getBalance(USDe, TEST_ACCOUNT);

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

    const usdeAfter = await getBalance(USDe, TEST_ACCOUNT);
    expect(usdeAfter).toBeGreaterThan(usdeBefore);

    expect(result.attestationPayload.venue).toBe(result.venue);
    expect(result.attestationPayload.amountIn).toBe(USDC_AMOUNT.toString());
    expect(result.attestationPayload.txHash).toBe(result.txHash);
  }, 120_000);

  it('RequoteOnExecute_PicksFreshBest: routes through a different venue after best pool is drained', async () => {
    const provider = makeProvider();

    // Get the current best route via quote.
    const initialQuote = await provider.actions.quote.invoke({
      tokenIn: USDC,
      tokenOut: USDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 100,
    });
    const staleBestRoute = initialQuote.bestRoute;

    // Map each venue to its on-chain quoter address.
    const venueQuoters: Record<string, Address> = {
      merchantMoe: ADDRESSES.mantleMainnet.mantleDex.merchantMoe.lbQuoter,
      agni: ADDRESSES.mantleMainnet.mantleDex.agni.quoterV2,
      fusionx: ADDRESSES.mantleMainnet.mantleDex.fusionx.quoterV2,
      woofi: ADDRESSES.mantleMainnet.mantleDex.woofi.router,
      lifi: ADDRESSES.mantleMainnet.lifi.diamond,
    };

    const staleQuoter = venueQuoters[staleBestRoute];
    // LiFi quotes via HTTP — draining diamond prevents execution but not quoting.
    // Skip if unmapped or LiFi (drain would not change best-route selection).
    if (staleQuoter === undefined || staleBestRoute === 'lifi') return;

    await drainContract(staleQuoter);

    const result = await provider.actions.swap.invoke({
      tokenIn: USDC,
      tokenOut: USDe,
      amountIn: USDC_AMOUNT,
      slippageBps: 100,
      recipient: TEST_ACCOUNT,
    });

    // Swap must succeed, but via a different venue.
    expect(result.venue).not.toBe(staleBestRoute);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(BigInt(result.amountOut)).toBeGreaterThan(0n);
  }, 120_000);

  it('SlippageBreach_RevertsBeforeSubmit: draining all venues prevents any swap execution', async () => {
    // Drain every on-chain venue quoter — all quote() calls return null → InsufficientLiquidity
    // fires before ensureApproval, so no tx is ever submitted.
    await Promise.all([
      drainContract(ADDRESSES.mantleMainnet.mantleDex.merchantMoe.lbQuoter),
      drainContract(ADDRESSES.mantleMainnet.mantleDex.agni.quoterV2),
      drainContract(ADDRESSES.mantleMainnet.mantleDex.fusionx.quoterV2),
      drainContract(ADDRESSES.mantleMainnet.mantleDex.woofi.router),
      drainContract(ADDRESSES.mantleMainnet.lifi.diamond),
    ]);

    const provider = makeProvider();
    const usdeBeforeAttempt = await getBalance(USDe, TEST_ACCOUNT);

    await expect(
      provider.actions.swap.invoke({
        tokenIn: USDC,
        tokenOut: USDe,
        amountIn: USDC_AMOUNT,
        slippageBps: 1,
        recipient: TEST_ACCOUNT,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError);

    // USDe balance must be unchanged — no tx was submitted.
    const usdeAfterAttempt = await getBalance(USDe, TEST_ACCOUNT);
    expect(usdeAfterAttempt).toBe(usdeBeforeAttempt);
  }, 60_000);
});
