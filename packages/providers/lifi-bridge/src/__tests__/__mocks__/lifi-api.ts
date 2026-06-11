import { HttpResponse, http } from 'msw';
import { LIFI_API } from '../../_context.ts';
import type { LifiBridgeRoute } from '../../_types.ts';

export const DEX_TX_HASH =
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as const;
export const DEST_TX_HASH =
  '0x9999999999999999999999999999999999999999999999999999999999999999' as const;

// Raw API response objects for GET /v1/quote — matches the Li.Fi Step schema
const QUOTE_RESPONSES = [
  {
    id: 'route-stargate-001',
    type: 'cross',
    tool: 'stargate',
    toolDetails: { name: 'Stargate', key: 'stargate' },
    action: {
      fromChainId: 5000,
      toChainId: 1,
      fromToken: {
        address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
        symbol: 'USDC',
        decimals: 6,
        chainId: 5000,
      },
      toToken: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 6,
        chainId: 1,
      },
      fromAmount: '100000000',
      fromAddress: '0x1111111111111111111111111111111111111111',
      slippage: 0.005,
    },
    estimate: {
      fromAmount: '100000000',
      toAmount: '99500000',
      toAmountMin: '99000000',
      executionDuration: 600,
      gasCosts: [
        {
          amount: '1000000000000000',
          amountUSD: '3.50',
          token: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'MNT',
            decimals: 18,
          },
        },
      ],
    },
    transactionRequest: {
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x3d0a87400000000000000000000000000000000000000000000000000000000000000001',
      value: '0',
      gasLimit: '500000',
      chainId: 5000,
    },
  },
  {
    id: 'route-across-002',
    type: 'cross',
    tool: 'across',
    toolDetails: { name: 'Across', key: 'across' },
    action: {
      fromChainId: 5000,
      toChainId: 1,
      fromToken: {
        address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
        symbol: 'USDC',
        decimals: 6,
        chainId: 5000,
      },
      toToken: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        symbol: 'USDC',
        decimals: 6,
        chainId: 1,
      },
      fromAmount: '100000000',
      fromAddress: '0x1111111111111111111111111111111111111111',
      slippage: 0.005,
    },
    estimate: {
      fromAmount: '100000000',
      toAmount: '99700000',
      toAmountMin: '99200000',
      executionDuration: 300,
      gasCosts: [
        {
          amount: '800000000000000',
          amountUSD: '2.80',
          token: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'MNT',
            decimals: 18,
          },
        },
      ],
    },
    transactionRequest: {
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x9d1b2a440000000000000000000000000000000000000000000000000000000000000002',
      value: '0',
      gasLimit: '500000',
      chainId: 5000,
    },
  },
] as const;

// Pre-normalized LifiBridgeRoute objects for test assertions (mirrors QUOTE_RESPONSES shape)
// _receivedAt is 0 as a placeholder — tests that care about freshness override it explicitly
export const FIXTURE_ROUTES: LifiBridgeRoute[] = [
  {
    id: 'route-stargate-001',
    tool: 'stargate',
    toolDetails: { name: 'Stargate', key: 'stargate' },
    fromChainId: 5000,
    toChainId: 1,
    fromToken: {
      address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
      symbol: 'USDC',
      decimals: 6,
      chainId: 5000,
    },
    toToken: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      chainId: 1,
    },
    estimate: {
      fromAmount: '100000000',
      toAmount: '99500000',
      toAmountMin: '99000000',
      executionDuration: 600,
      gasCosts: [
        {
          amount: '1000000000000000',
          amountUSD: '3.50',
          token: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'MNT',
            decimals: 18,
          },
        },
      ],
    },
    transactionRequest: {
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x3d0a87400000000000000000000000000000000000000000000000000000000000000001',
      value: '0',
      gasLimit: '500000',
      chainId: 5000,
    },
    _receivedAt: 0,
  },
  {
    id: 'route-across-002',
    tool: 'across',
    toolDetails: { name: 'Across', key: 'across' },
    fromChainId: 5000,
    toChainId: 1,
    fromToken: {
      address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
      symbol: 'USDC',
      decimals: 6,
      chainId: 5000,
    },
    toToken: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      chainId: 1,
    },
    estimate: {
      fromAmount: '100000000',
      toAmount: '99700000',
      toAmountMin: '99200000',
      executionDuration: 300,
      gasCosts: [
        {
          amount: '800000000000000',
          amountUSD: '2.80',
          token: {
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'MNT',
            decimals: 18,
          },
        },
      ],
    },
    transactionRequest: {
      to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      data: '0x9d1b2a440000000000000000000000000000000000000000000000000000000000000002',
      value: '0',
      gasLimit: '500000',
      chainId: 5000,
    },
    _receivedAt: 0,
  },
];

export const handlers = [
  // GET /v1/quote — returns best non-denied route, 422 if all bridges excluded
  http.get(`${LIFI_API}/quote`, ({ request }) => {
    const url = new URL(request.url);
    const denied = new Set((url.searchParams.get('denyBridges') ?? '').split(',').filter(Boolean));
    const quote = QUOTE_RESPONSES.find((q) => !denied.has(q.tool));
    if (!quote) return new HttpResponse(null, { status: 422 });
    return HttpResponse.json(quote);
  }),

  http.get(`${LIFI_API}/status`, ({ request }) => {
    const url = new URL(request.url);
    const txHash = url.searchParams.get('txHash');

    if (txHash === DEX_TX_HASH) {
      return HttpResponse.json({
        status: 'DONE',
        tool: 'stargate',
        fromTx: { txHash: DEX_TX_HASH, chainId: 5000 },
        toTx: { txHash: DEST_TX_HASH, chainId: 1 },
      });
    }

    if (txHash === '0x1111111111111111111111111111111111111111111111111111111111111111') {
      return HttpResponse.json({ status: 'PENDING', fromTx: { txHash, chainId: 5000 } });
    }

    return HttpResponse.json({ status: 'NOT_FOUND' });
  }),
];
