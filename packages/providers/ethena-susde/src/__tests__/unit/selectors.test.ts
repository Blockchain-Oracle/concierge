import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it, vi } from 'vitest';
import { getBalanceSusde, getBalanceUSDe, getPriceUSD } from '../../selectors.ts';

const USDE = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' as const;
const SUSDE = '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2' as const;
const ORACLE = '0x47a063CfDa980532267970d478EC340C0F80E8df' as const;
const USER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' as const;
const BALANCE = 2_500_000_000_000_000_000n;
const PRICE = 123_214_617n; // $1.232 in 1e8 units

// biome-ignore lint/suspicious/noExplicitAny: minimal mock
function makeClient(readContract: ReturnType<typeof vi.fn>): any {
  return { readContract };
}

describe('getBalanceUSDe', () => {
  it('reads balanceOf on the USDe contract for the given user', async () => {
    const readContract = vi.fn().mockResolvedValue(BALANCE);
    const result = await getBalanceUSDe(makeClient(readContract), USDE, USER);
    expect(result).toBe(BALANCE);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: USDE, functionName: 'balanceOf', args: [USER] }),
    );
  });

  it('throws ConciergeError(RpcError) when readContract fails', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('rpc error'));
    await expect(getBalanceUSDe(makeClient(readContract), USDE, USER)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('getBalanceSusde', () => {
  it('reads balanceOf on the sUSDe contract for the given user', async () => {
    const readContract = vi.fn().mockResolvedValue(BALANCE);
    const result = await getBalanceSusde(makeClient(readContract), SUSDE, USER);
    expect(result).toBe(BALANCE);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: SUSDE, functionName: 'balanceOf', args: [USER] }),
    );
  });

  it('throws ConciergeError(RpcError) when readContract fails', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('rpc error'));
    await expect(getBalanceSusde(makeClient(readContract), SUSDE, USER)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});

describe('getPriceUSD', () => {
  it('calls getAssetPrice on the oracle with the sUSDe token address', async () => {
    const readContract = vi.fn().mockResolvedValue(PRICE);
    const result = await getPriceUSD(makeClient(readContract), ORACLE, SUSDE);
    expect(result).toBe(PRICE);
    // Must pass susdeAddress as the asset arg — NOT oracleAddress
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: ORACLE,
        functionName: 'getAssetPrice',
        args: [SUSDE],
      }),
    );
  });

  it('throws ConciergeError(RpcError) when oracle readContract fails', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('rpc error'));
    await expect(getPriceUSD(makeClient(readContract), ORACLE, SUSDE)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'RpcError',
    );
  });
});
