import type { FeedbackEnvelope, SchemaId } from '../../schema.ts';

const base = {
  v: 1 as const,
  agentId: 'agent-1',
  chainId: 5000,
  createdAt: '2026-06-13T12:00:00Z',
};

export const FIXTURES: Record<SchemaId, FeedbackEnvelope> = {
  'concierge.aave.v3.supply.v1': {
    ...base,
    schema: 'concierge.aave.v3.supply.v1',
    txHash: `0x${'a'.repeat(64)}`,
    payload: { asset: '0xUSDC', amount: '100000000' },
  },
  'concierge.aave.v3.borrow.v1': {
    ...base,
    schema: 'concierge.aave.v3.borrow.v1',
    payload: { asset: '0xUSDC', amount: '50000000', rateMode: 'variable' },
  },
  'concierge.aave.v3.repay.v1': {
    ...base,
    schema: 'concierge.aave.v3.repay.v1',
    payload: { asset: '0xUSDC', amount: 'max' },
  },
  'concierge.aave.v3.withdraw.v1': {
    ...base,
    schema: 'concierge.aave.v3.withdraw.v1',
    payload: { asset: '0xUSDC', amount: '50000000' },
  },
  'concierge.mantle-dex.swap.v1': {
    ...base,
    schema: 'concierge.mantle-dex.swap.v1',
    payload: {
      venue: 'merchant-moe',
      tokenIn: '0xUSDC',
      tokenOut: '0xUSDT',
      amountIn: '100000000',
      amountOutMin: '99500000',
    },
  },
  'concierge.ethena.susde.wrap.v1': {
    ...base,
    schema: 'concierge.ethena.susde.wrap.v1',
    payload: { usdeAmount: '100000000000000000000' },
  },
  'concierge.ondo.usdy.subscribe.v1': {
    ...base,
    schema: 'concierge.ondo.usdy.subscribe.v1',
    payload: { usdcAmount: '100000000' },
  },
  'concierge.meth-staking.stake.v1': {
    ...base,
    schema: 'concierge.meth-staking.stake.v1',
    payload: { ethAmount: '1000000000000000000' },
  },
  'concierge.lifi.bridge.v1': {
    ...base,
    schema: 'concierge.lifi.bridge.v1',
    txHash: `0x${'b'.repeat(64)}`,
    payload: { srcChainId: 5000, dstChainId: 1, bridge: 'stargate', amount: '1000000000' },
  },
};

export const AAVE_SUPPLY = FIXTURES['concierge.aave.v3.supply.v1'];
export const MANTLE_DEX_SWAP = FIXTURES['concierge.mantle-dex.swap.v1'];
export const LIFI_BRIDGE = FIXTURES['concierge.lifi.bridge.v1'];
