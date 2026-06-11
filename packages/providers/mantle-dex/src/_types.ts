import type { Address, Hex } from '@concierge/shared';

export type VenueName = 'merchantMoe' | 'agni' | 'fusionx' | 'woofi' | 'lifi';

export interface VenueQuoteParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  account?: Address;
}

export interface VenueQuoteResult {
  venue: VenueName;
  amountOut: bigint;
  gasEstimate?: bigint;
}

export interface VenueSwapParams {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  recipient: Address;
  account: Address;
  deadline: bigint;
}

export interface VenueSwapResult {
  txHash: Hex;
  amountOut: bigint;
  spender: Address;
}

export interface Venue {
  readonly name: VenueName;
  quote(params: VenueQuoteParams): Promise<VenueQuoteResult | null>;
  swap(params: VenueSwapParams): Promise<VenueSwapResult>;
}
