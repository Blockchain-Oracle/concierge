// Pure-compute unit tests for the best-of-N venue aggregation logic.
// No chain, no fork — exercises sorting + null-filtering in resolveRouteMap.
import { ConciergeError } from '@concierge/sdk';
import type { Address } from '@concierge/shared';
import { describe, expect, it } from 'vitest';
import type { VenueQuoteResult } from '../_types.ts';
import { type RouteMap, resolveRouteMap } from '../actions/quote.ts';

const TOKEN_A = '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as Address;
const TOKEN_B = '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' as Address;

function r(venue: VenueQuoteResult['venue'], amountOut: bigint): VenueQuoteResult {
  return { venue, amountOut };
}

function routeMap(overrides: Partial<RouteMap>): RouteMap {
  return {
    merchantMoe: null,
    agni: null,
    fusionx: null,
    woofi: null,
    lifi: null,
    ...overrides,
  };
}

describe('resolveRouteMap — best-of-N aggregation (pure compute)', () => {
  it('picks venue with highest amountOut', async () => {
    const result = await resolveRouteMap(
      routeMap({
        merchantMoe: r('merchantMoe', 900_000n),
        agni: r('agni', 1_050_000n),
        woofi: r('woofi', 980_000n),
      }),
      TOKEN_A,
      TOKEN_B,
    );
    expect(result.bestRoute).toBe('agni');
    expect(result.bestAmountOut).toBe('1050000');
  });

  it('ignores null venues and picks from the rest', async () => {
    const result = await resolveRouteMap(
      routeMap({ fusionx: r('fusionx', 750_000n) }),
      TOKEN_A,
      TOKEN_B,
    );
    expect(result.bestRoute).toBe('fusionx');
    expect(result.bestAmountOut).toBe('750000');
  });

  it('null venues appear in allRoutes with amountOut: null and reason: no_route', async () => {
    const result = await resolveRouteMap(
      routeMap({ merchantMoe: r('merchantMoe', 1_000_000n), woofi: r('woofi', 999_000n) }),
      TOKEN_A,
      TOKEN_B,
    );
    expect(result.allRoutes.agni).toMatchObject({ amountOut: null, reason: 'no_route' });
    expect(result.allRoutes.fusionx).toMatchObject({ amountOut: null, reason: 'no_route' });
    expect(result.allRoutes.lifi).toMatchObject({ amountOut: null, reason: 'no_route' });
  });

  it('successful venues appear in allRoutes with amountOut as decimal string', async () => {
    const result = await resolveRouteMap(
      routeMap({ merchantMoe: r('merchantMoe', 1_000_000n) }),
      TOKEN_A,
      TOKEN_B,
    );
    expect(result.allRoutes.merchantMoe).toMatchObject({ amountOut: '1000000' });
  });

  it('bestAmountOut matches allRoutes entry for bestRoute', async () => {
    const result = await resolveRouteMap(
      routeMap({
        merchantMoe: r('merchantMoe', 500_000n),
        agni: r('agni', 800_000n),
        fusionx: r('fusionx', 750_000n),
        lifi: r('lifi', 820_000n),
      }),
      TOKEN_A,
      TOKEN_B,
    );
    const bestEntry = result.allRoutes[result.bestRoute];
    expect(bestEntry.amountOut).toBe(result.bestAmountOut);
    expect(result.bestRoute).toBe('lifi');
  });

  it('throws InsufficientLiquidity when all venues return null', async () => {
    await expect(resolveRouteMap(routeMap({}), TOKEN_A, TOKEN_B)).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });

  it('does not pick a null entry as best even if it appears first', async () => {
    const result = await resolveRouteMap(routeMap({ agni: r('agni', 1n) }), TOKEN_A, TOKEN_B);
    expect(result.bestRoute).toBe('agni');
  });

  it('treats amountOut === 0n as no-route — throws InsufficientLiquidity when only zero-amount venues exist', async () => {
    await expect(
      resolveRouteMap(routeMap({ agni: r('agni', 0n) }), TOKEN_A, TOKEN_B),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InsufficientLiquidity',
    );
  });

  it('skips zero-amount venue and picks the positive-amount one', async () => {
    const result = await resolveRouteMap(
      routeMap({ agni: r('agni', 0n), woofi: r('woofi', 5n) }),
      TOKEN_A,
      TOKEN_B,
    );
    expect(result.bestRoute).toBe('woofi');
    expect(result.bestAmountOut).toBe('5');
  });
});
