// Unit tests for createLifiVenue — fetch is mocked; no fork required.
import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifiVenue } from '../../venues/lifi.ts';

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae' as Address;
const TOKEN_IN = '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as Address;
const TOKEN_OUT = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' as Address;
const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Address;

function makeVenue() {
  return createLifiVenue(5000, {} as never, undefined, DIAMOND);
}

function mockFetchOk(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

function mockFetchNotOk(status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as Response);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('createLifiVenue — quote', () => {
  it('returns null when Li.Fi returns HTTP 4xx', async () => {
    mockFetchNotOk(400);
    const venue = makeVenue();
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when estimate.toAmount is missing', async () => {
    mockFetchOk({ estimate: {} });
    const venue = makeVenue();
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns null when estimate.toAmount is 0', async () => {
    mockFetchOk({ estimate: { toAmount: '0' } });
    const venue = makeVenue();
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('returns result with approvalAddress when present', async () => {
    const approvalAddress = '0xabcd000000000000000000000000000000000000';
    mockFetchOk({ estimate: { toAmount: '999000', approvalAddress } });
    const venue = makeVenue();
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toMatchObject({ venue: 'lifi', amountOut: 999_000n, approvalAddress });
  });

  it('returns result without approvalAddress when not in response', async () => {
    mockFetchOk({ estimate: { toAmount: '999000' } });
    const venue = makeVenue();
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toMatchObject({ venue: 'lifi', amountOut: 999_000n });
    expect(result).not.toHaveProperty('approvalAddress');
  });

  it('returns null on AbortError (timeout)', async () => {
    const abortErr = new DOMException('signal timed out', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortErr);
    const venue = makeVenue();
    const result = await venue.quote({
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000_000n,
    });
    expect(result).toBeNull();
  });

  it('propagates non-abort errors (network failure)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const venue = makeVenue();
    await expect(
      venue.quote({ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: 1_000_000n }),
    ).rejects.toThrow(TypeError);
  });
});

describe('createLifiVenue — swap', () => {
  it('throws ConfigError when walletClient is absent', async () => {
    const venue = makeVenue();
    await expect(
      venue.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000_000n,
        amountOutMin: 990_000n,
        slippageBps: 50,
        recipient: ACCOUNT,
        account: ACCOUNT,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('throws InsufficientLiquidity when Li.Fi returns no transactionRequest', async () => {
    mockFetchOk({ estimate: { toAmount: '999000' } }); // missing transactionRequest
    const walletClient = { chain: null, sendTransaction: vi.fn(), account: { address: ACCOUNT } };
    const venue = createLifiVenue(5000, {} as never, walletClient as never, DIAMOND);
    await expect(
      venue.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000_000n,
        amountOutMin: 990_000n,
        slippageBps: 50,
        recipient: ACCOUNT,
        account: ACCOUNT,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });

  it('throws RpcError when transactionRequest.to is missing', async () => {
    mockFetchOk({
      estimate: { toAmount: '999000' },
      transactionRequest: { data: '0x', value: '0' }, // missing to
    });
    const walletClient = { chain: null, sendTransaction: vi.fn(), account: { address: ACCOUNT } };
    const venue = createLifiVenue(5000, {} as never, walletClient as never, DIAMOND);
    await expect(
      venue.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000_000n,
        amountOutMin: 990_000n,
        slippageBps: 50,
        recipient: ACCOUNT,
        account: ACCOUNT,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });

  it('throws RpcError when estimate.toAmount is missing on swap response', async () => {
    mockFetchOk({
      // Missing toAmount in estimate — cannot build attestation
      transactionRequest: {
        to: '0xabcd000000000000000000000000000000000001',
        data: '0x',
        value: '0',
      },
    });
    const txHash = `0x${'e'.repeat(64)}` as `0x${string}`;
    const walletClient = {
      chain: null,
      sendTransaction: vi.fn().mockResolvedValue(txHash),
      account: { address: ACCOUNT },
    };
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    };
    const venue = createLifiVenue(5000, publicClient as never, walletClient as never, DIAMOND);
    await expect(
      venue.swap({
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000_000n,
        amountOutMin: 990_000n,
        slippageBps: 50,
        recipient: ACCOUNT,
        account: ACCOUNT,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});
