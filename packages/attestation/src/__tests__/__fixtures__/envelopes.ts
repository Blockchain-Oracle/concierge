import type { FeedbackEnvelope } from '../../schema.ts';

export const AAVE_SUPPLY: FeedbackEnvelope = {
  v: 1,
  schema: 'concierge.aave.v3.supply.v1',
  agentId: 'agent-1',
  chainId: 5000,
  txHash: `0x${'a'.repeat(64)}`,
  payload: {
    asset: '0xUSDC',
    amount: '100000000', // 100 USDC (6 decimals)
    onBehalfOf: '0xUser',
  },
  createdAt: '2026-06-13T12:00:00Z',
};

export const MANTLE_DEX_SWAP: FeedbackEnvelope = {
  v: 1,
  schema: 'concierge.mantle-dex.swap.v1',
  agentId: 'agent-1',
  chainId: 5000,
  payload: {
    venue: 'merchant-moe',
    tokenIn: '0xUSDC',
    tokenOut: '0xUSDT',
    amountIn: '100000000',
    amountOutMin: '99500000',
  },
  createdAt: '2026-06-13T12:01:00Z',
};

export const LIFI_BRIDGE: FeedbackEnvelope = {
  v: 1,
  schema: 'concierge.lifi.bridge.v1',
  agentId: 'agent-1',
  chainId: 5000,
  txHash: `0x${'b'.repeat(64)}`,
  payload: {
    srcChainId: 5000,
    dstChainId: 1,
    bridge: 'stargate',
    amount: '1000000000',
  },
  createdAt: '2026-06-13T12:02:00Z',
};
