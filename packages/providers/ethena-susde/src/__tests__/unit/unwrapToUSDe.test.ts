import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '../../_context.ts';
import { executeUnwrapToUSDe } from '../../actions/unwrapToUSDe.ts';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const USDE = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' as const;
const SUSDE = '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2' as const;
const WOOFI = '0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7' as const;
const RECIPIENT = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as const;
const AMOUNT = 1_000_000_000_000_000_000n; // 1 sUSDe (18 decimals)

function makeCtx(overrides?: { querySwapResult?: bigint; walletClient?: unknown }): ActionContext {
  return {
    publicClient: {
      readContract: vi.fn().mockResolvedValue(overrides?.querySwapResult ?? AMOUNT),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    } as any,
    walletClient: overrides?.walletClient as ActionContext['walletClient'],
    chainId: 5000,
    addresses: {
      usde: USDE,
      susde: SUSDE,
      usdc: ZERO,
      aavePool: ZERO,
      aaveOracle: ZERO,
      woofiRouter: WOOFI,
    },
  };
}

const DUMMY_ACCOUNT = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as const;
const DUMMY_WALLET = { account: { address: DUMMY_ACCOUNT }, chain: null };
const VALID_INPUT = { amountSusde: AMOUNT, slippageBps: 50, recipient: RECIPIENT };

describe('executeUnwrapToUSDe — requireWallet guards', () => {
  it('throws ConfigError when walletClient is missing', async () => {
    await expect(executeUnwrapToUSDe(makeCtx(), VALID_INPUT)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });

  it('throws ConfigError when walletClient has no bound account', async () => {
    const walletClient = { account: undefined, chain: null };
    await expect(executeUnwrapToUSDe(makeCtx({ walletClient }), VALID_INPUT)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError',
    );
  });
});

describe('executeUnwrapToUSDe — liquidity guards', () => {
  it('throws InsufficientLiquidity when querySwap returns 0 (no route)', async () => {
    await expect(
      executeUnwrapToUSDe(
        makeCtx({ querySwapResult: 0n, walletClient: DUMMY_WALLET }),
        VALID_INPUT,
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });

  it('throws InsufficientLiquidity when minOut rounds to 0 (dust after slippage)', async () => {
    // quoted=1n, slippageBps=9999 → minOut = (1n * 1n) / 10000n = 0n
    await expect(
      executeUnwrapToUSDe(makeCtx({ querySwapResult: 1n, walletClient: DUMMY_WALLET }), {
        amountSusde: AMOUNT,
        slippageBps: 9999,
        recipient: RECIPIENT,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });
});
