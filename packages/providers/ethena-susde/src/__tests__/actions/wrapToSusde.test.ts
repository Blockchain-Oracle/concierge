// Integration tests for wrapToSusde — tests the full action pipeline from input validation
// through queryMinOut → ensureApproval → executeWooFiSwap → buildAttestationPayload.
//
// Fork note: WooFi on Mantle mainnet does NOT have a USDe/sUSDe pool as of fork date.
// The fork test verifies the error path. Happy-path tests use a mocked publicClient to
// simulate WooFi having liquidity, covering the full action code path.
import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeWrapToSusde } from '../../actions/wrapToSusde.ts';
import {
  type AnvilFork,
  startAnvilFork,
  TEST_ACCOUNT,
  TEST_PRIVATE_KEY,
  TOKEN_BALANCE_SLOTS,
} from '../setup.ts';

const { USDe, sUSDe } = ADDRESSES.mantleMainnet.tokens;

const SEED_USDE = 500_000_000_000_000_000_000n; // 500 USDe
const WRAP_AMOUNT = 100_000_000_000_000_000_000n; // 100 USDe
const MOCK_QUOTE = 99_500_000_000_000_000_000n; // 99.5 sUSDe (simulated WooFi quote)
const TX_HASH = `0x${'cd'.repeat(32)}` as const;

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();
  const slot = TOKEN_BALANCE_SLOTS[USDe.toLowerCase()];
  if (slot === undefined) throw new Error('USDe balance slot not configured');
  await fork.setErc20Balance(USDe, TEST_ACCOUNT, SEED_USDE, slot);
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

describe('wrapToSusde — happy path (mocked WooFi liquidity)', () => {
  it('completes full wrap pipeline: quote → approve → swap → attestation', async () => {
    // Simulate WooFi having liquidity for USDe → sUSDe.
    // Routes readContract by functionName to avoid ordering fragility.
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock for fork integration test
    const publicClient: any = {
      readContract: vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
        if (functionName === 'querySwap') return Promise.resolve(MOCK_QUOTE);
        if (functionName === 'allowance') return Promise.resolve(WRAP_AMOUNT); // no approve needed
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

    const result = await executeWrapToSusde(ctx, {
      amountUSDe: WRAP_AMOUNT,
      slippageBps: 50,
      recipient: TEST_ACCOUNT,
    });

    expect(result.txHash).toBe(TX_HASH);
    expect(result.attestationPayload.schema).toBe('concierge.ethena.wrap.v1');
    expect(BigInt(result.amountSusdeOut)).toBeGreaterThan(0n);
    expect(result.amountUsdeIn).toBe(WRAP_AMOUNT.toString());
  });
});

describe('wrapToSusde — fork (real WooFi on Mantle mainnet)', () => {
  it('throws InsufficientLiquidity when WooFi has no USDe → sUSDe pool on Mantle', async () => {
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
    // WooFi on Mantle does not have a USDe/sUSDe pool — querySwap reverts.
    await expect(
      executeWrapToSusde(ctx, {
        amountUSDe: WRAP_AMOUNT,
        slippageBps: 50,
        recipient: TEST_ACCOUNT,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  }, 30_000);
});
