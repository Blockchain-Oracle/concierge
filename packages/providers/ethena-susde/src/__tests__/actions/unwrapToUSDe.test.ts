// Integration tests for unwrapToUSDe — tests the full action pipeline from input validation
// through queryMinOut → ensureApproval → executeWooFiSwap → buildAttestationPayload.
//
// Fork note: WooFi on Mantle mainnet does NOT have a sUSDe/USDe pool as of fork date.
// On Mantle, sUSDe is a LayerZero V2 OFT — there is NO 7-day cooldown (the cooldown is
// L1-only). Unwrap is a plain DEX swap. The absence of a cooldown is verified by the
// fact that the implementation makes no cooldown reads (confirmed by the unit mock test).
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeUnwrapToUSDe } from '../../actions/unwrapToUSDe.ts';
import {
  type AnvilFork,
  startAnvilFork,
  TEST_ACCOUNT,
  TEST_PRIVATE_KEY,
  TOKEN_BALANCE_SLOTS,
} from '../setup.ts';

const { USDe, sUSDe } = ADDRESSES.mantleMainnet.tokens;

const SEED_SUSDE = 500_000_000_000_000_000_000n; // 500 sUSDe
const UNWRAP_AMOUNT = 50_000_000_000_000_000_000n; // 50 sUSDe
const MOCK_QUOTE = 49_800_000_000_000_000_000n; // 49.8 USDe (simulated WooFi quote)
const TX_HASH = `0x${'ef'.repeat(32)}` as const;

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();
  const slot = TOKEN_BALANCE_SLOTS[sUSDe.toLowerCase()];
  if (slot === undefined) throw new Error('sUSDe balance slot not configured');
  await fork.setErc20Balance(sUSDe, TEST_ACCOUNT, SEED_SUSDE, slot);
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

describe('unwrapToUSDe — happy path (mocked WooFi liquidity)', () => {
  it('completes full unwrap pipeline with no cooldown wait — Mantle sUSDe is LayerZero OFT', async () => {
    // Simulate WooFi having sUSDe → USDe liquidity.
    // Routes readContract by functionName to avoid ordering fragility.
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock for fork integration test
    const publicClient: any = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'querySwap') return Promise.resolve(MOCK_QUOTE);
        if (functionName === 'allowance') return Promise.resolve(UNWRAP_AMOUNT); // no approve needed
        return Promise.reject(new Error(`Unexpected readContract: ${functionName}`));
      }),
      simulateContract: vi.fn().mockResolvedValue({ result: MOCK_QUOTE, request: {} }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
    };
    const walletClient = createWalletClient({
      account: privateKeyToAccount(TEST_PRIVATE_KEY),
      transport: http(`http://127.0.0.1:${fork.port}`),
      chain: fork.chain,
    });
    const ctx = {
      publicClient,
      walletClient,
      chainId: 5000 as const,
      addresses: {
        usde: USDe,
        susde: sUSDe,
        usdc: ADDRESSES.mantleMainnet.tokens.USDC,
        aavePool: ADDRESSES.mantleMainnet.aave.pool,
        aaveOracle: ADDRESSES.mantleMainnet.aave.oracle,
        woofiRouter: ADDRESSES.mantleMainnet.mantleDex.woofi.router,
      },
    };
    vi.spyOn(walletClient, 'writeContract').mockResolvedValue(TX_HASH);

    // No `anvilClient.setNextBlockTimestamp` needed — WooFi swap has no cooldown.
    const result = await executeUnwrapToUSDe(ctx, {
      amountSusde: UNWRAP_AMOUNT,
      slippageBps: 50,
      recipient: TEST_ACCOUNT,
    });

    expect(result.txHash).toBe(TX_HASH);
    expect(result.attestationPayload.schema).toBe('concierge.ethena.unwrap.v1');
    expect(BigInt(result.amountUsdeOut)).toBeGreaterThan(0n);
    expect(result.amountSusdeIn).toBe(UNWRAP_AMOUNT.toString());
  });
});

describe('unwrapToUSDe — fork (real WooFi on Mantle mainnet)', () => {
  it('throws InsufficientLiquidity when WooFi has no sUSDe → USDe pool on Mantle', async () => {
    const ctx = {
      publicClient: fork.publicClient,
      walletClient: fork.walletClient,
      chainId: 5000 as const,
      addresses: {
        usde: USDe,
        susde: sUSDe,
        usdc: ADDRESSES.mantleMainnet.tokens.USDC,
        aavePool: ADDRESSES.mantleMainnet.aave.pool,
        aaveOracle: ADDRESSES.mantleMainnet.aave.oracle,
        woofiRouter: ADDRESSES.mantleMainnet.mantleDex.woofi.router,
      },
    };
    // WooFi on Mantle does not have a sUSDe/USDe pool — querySwap reverts.
    await expect(
      executeUnwrapToUSDe(ctx, {
        amountSusde: UNWRAP_AMOUNT,
        slippageBps: 50,
        recipient: TEST_ACCOUNT,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  }, 30_000);
});
