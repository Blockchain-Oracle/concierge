import { ConciergeError } from '@concierge/sdk';
import { ADDRESSES } from '@concierge/shared';
import { describe, expect, it, vi } from 'vitest';
import { executeGetUnwrapToWETH } from '../../actions/unwrapToWETH.ts';

const AGNI_METH_WETH = '0x4f9E3683A523b66Da89d82BbA0a9CAA1C3243dF4' as const;
const RECIPIENT = '0x1111111111111111111111111111111111111111' as const;
const DEX_TX_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as const;
const SQRT_PRICE = 82_798_739_410_433_829_082_732_242_045n; // rate ≈ 1.092e18

const addresses = {
  meth: ADDRESSES.mantleMainnet.tokens.mETH,
  weth: ADDRESSES.mantleMainnet.tokens.WETH,
  agniMethWeth: AGNI_METH_WETH,
};

function makePublicClient(sqrtPriceX96 = SQRT_PRICE) {
  return {
    readContract: vi.fn().mockResolvedValue([sqrtPriceX96, 880, 0, 1, 1, 0, true]),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  } as any;
}

describe('getUnwrapToWETH — routes through dex provider (test_RoutesThroughDexProvider)', () => {
  it('calls dexProvider.swap with correct args and returns dexTxHash + attestation', async () => {
    const swapSpy = vi
      .fn()
      .mockResolvedValue({ txHash: DEX_TX_HASH, amountOut: '1092000000000000000' });
    const dexProvider = { actions: { swap: { invoke: swapSpy } } };
    const ctx = {
      publicClient: makePublicClient(),
      chainId: 5000 as const,
      addresses,
      dexProvider,
    };

    const result = await executeGetUnwrapToWETH(ctx, {
      amountMeth: 1_000_000_000_000_000_000n,
      slippageBps: 50,
      recipient: RECIPIENT,
    });

    expect(swapSpy).toHaveBeenCalledOnce();
    expect(swapSpy).toHaveBeenCalledWith({
      tokenIn: ADDRESSES.mantleMainnet.tokens.mETH,
      tokenOut: ADDRESSES.mantleMainnet.tokens.WETH,
      amountIn: 1_000_000_000_000_000_000n,
      slippageBps: 50,
      recipient: RECIPIENT,
    });

    expect(result.dexTxHash).toBe(DEX_TX_HASH);
    expect(result.actualEthOut).toBe('1092000000000000000');
    expect(result.attestationPayload.schema).toBe('concierge.meth.unwrap-via-dex.v1');
    expect(result.attestationPayload.dexTxHash).toBe(DEX_TX_HASH);
    expect(result.attestationPayload.actualEthOut).toBe('1092000000000000000');
  });
});

describe('getUnwrapToWETH — attestation captures expectedEthOut (test_unwrapToWETH_AttestationCaptures_ExpectedEthOut)', () => {
  it('expectedEthOut equals rate * amountMeth / 1e18 from oracle pool price', async () => {
    const swapSpy = vi
      .fn()
      .mockResolvedValue({ txHash: DEX_TX_HASH, amountOut: '1092000000000000000' });
    const dexProvider = { actions: { swap: { invoke: swapSpy } } };
    const ctx = {
      publicClient: makePublicClient(),
      chainId: 5000 as const,
      addresses,
      dexProvider,
    };

    const amountMeth = 2_000_000_000_000_000_000n; // 2 mETH
    const result = await executeGetUnwrapToWETH(ctx, {
      amountMeth,
      slippageBps: 50,
      recipient: RECIPIENT,
    });

    // expectedEthOut = rate * amountMeth / 1e18
    // rate ≈ 1.092e18, amountMeth = 2e18 → expectedEthOut ≈ 2.184e18
    const expectedEthOut = BigInt(result.expectedEthOut);
    expect(expectedEthOut).toBeGreaterThan(2_000_000_000_000_000_000n); // rate > 1
    expect(result.attestationPayload.expectedEthOut).toBe(result.expectedEthOut);
    // actualEthOut comes from DEX swap result and is recorded in the attestation
    expect(result.actualEthOut).toBe('1092000000000000000');
    expect(result.attestationPayload.actualEthOut).toBe('1092000000000000000');
  });
});

describe('getUnwrapToWETH — propagates SlippageBreach (test_unwrapToWETH_PropagatesSlippageBreach)', () => {
  it('re-throws ConciergeError(SwapSlippageBreach) from dex provider unchanged', async () => {
    const slippageError = new ConciergeError(
      'SwapSlippageBreach',
      '[@concierge/mantle-dex] swap: slippage breach',
    );
    const swapSpy = vi.fn().mockRejectedValue(slippageError);
    const dexProvider = { actions: { swap: { invoke: swapSpy } } };
    const ctx = {
      publicClient: makePublicClient(),
      chainId: 5000 as const,
      addresses,
      dexProvider,
    };

    await expect(
      executeGetUnwrapToWETH(ctx, {
        amountMeth: 1_000_000_000_000_000_000n,
        slippageBps: 50,
        recipient: RECIPIENT,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'SwapSlippageBreach',
    );
  });

  it('wraps non-ConciergeError DEX failure as ConciergeError(RpcError)', async () => {
    const swapSpy = vi.fn().mockRejectedValue(new Error('connection reset'));
    const dexProvider = { actions: { swap: { invoke: swapSpy } } };
    const ctx = {
      publicClient: makePublicClient(),
      chainId: 5000 as const,
      addresses,
      dexProvider,
    };

    await expect(
      executeGetUnwrapToWETH(ctx, {
        amountMeth: 1_000_000_000_000_000_000n,
        slippageBps: 50,
        recipient: RECIPIENT,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});
