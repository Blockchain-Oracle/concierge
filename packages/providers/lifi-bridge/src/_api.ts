import { ConciergeError } from '@concierge/sdk';
import { LIFI_API } from './_context.ts';
import {
  type LifiBridgeRoute,
  LifiQuoteResponseSchema,
  type LifiStatusResponse,
  LifiStatusResponseSchema,
} from './_types.ts';

function apiHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (apiKey) h['x-lifi-api-key'] = apiKey;
  return h;
}

async function doFetch(url: string, init: RequestInit, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] ${label}: network error`,
      err instanceof Error ? err : undefined,
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as Record<string, unknown>;
      // biome-ignore lint/complexity/useLiteralKeys: tsconfig noPropertyAccessFromIndexSignature requires bracket notation here
      if (typeof body['message'] === 'string') detail = ` — ${body['message']}`;
    } catch {
      // error body may not be JSON (e.g. gateway HTML) — omit detail
    }
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] ${label}: HTTP ${res.status}${detail}`,
    );
  }

  try {
    return await res.json();
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] ${label}: response is not valid JSON`,
      err instanceof Error ? err : undefined,
    );
  }
}

export interface GetQuoteParams {
  fromChainId: number;
  toChainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  slippage: number;
  integrator: string;
  apiKey: string | undefined;
  denyBridges: string[] | undefined;
}

function normalizeQuote(
  raw: ReturnType<typeof LifiQuoteResponseSchema.parse>,
  receivedAt: number,
): LifiBridgeRoute | null {
  const { fromAmount, toAmount, toAmountMin, executionDuration } = raw.estimate;
  // Reject routes with missing amounts — '0' is not a safe fallback for on-chain attestation
  if (!fromAmount || !toAmount || !toAmountMin || executionDuration === undefined) return null;

  return {
    id: raw.id,
    tool: raw.tool,
    toolDetails: raw.toolDetails,
    fromChainId: raw.action.fromChainId,
    toChainId: raw.action.toChainId,
    fromToken: raw.action.fromToken,
    toToken: raw.action.toToken,
    estimate: {
      fromAmount,
      toAmount,
      toAmountMin,
      executionDuration,
      gasCosts: raw.estimate.gasCosts,
    },
    transactionRequest: raw.transactionRequest,
    _receivedAt: receivedAt,
  };
}

export async function fetchQuote(params: GetQuoteParams): Promise<LifiBridgeRoute | null> {
  const url = new URL(`${LIFI_API}/quote`);
  url.searchParams.set('fromChain', String(params.fromChainId));
  url.searchParams.set('toChain', String(params.toChainId));
  url.searchParams.set('fromToken', params.fromTokenAddress);
  url.searchParams.set('toToken', params.toTokenAddress);
  url.searchParams.set('fromAmount', params.fromAmount);
  url.searchParams.set('fromAddress', params.fromAddress);
  url.searchParams.set('toAddress', params.toAddress);
  url.searchParams.set('slippage', String(params.slippage));
  url.searchParams.set('integrator', params.integrator);
  if (params.denyBridges && params.denyBridges.length > 0) {
    url.searchParams.set('denyBridges', params.denyBridges.join(','));
  }

  let json: unknown;
  try {
    json = await doFetch(url.toString(), { headers: apiHeaders(params.apiKey) }, 'fetchQuote');
  } catch (err) {
    // Li.Fi returns HTTP 422 when no route is available for the pair — surface as null, not error
    if (err instanceof ConciergeError && /HTTP 422/.test(err.message)) return null;
    throw err;
  }

  const parsed = LifiQuoteResponseSchema.safeParse(json);
  if (!parsed.success)
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] fetchQuote: unexpected response shape — ${parsed.error.message}`,
    );

  const route = normalizeQuote(parsed.data, Date.now());
  if (!route)
    throw new ConciergeError(
      'RpcError',
      '[@concierge/lifi-bridge] fetchQuote: Li.Fi returned a route missing required amount fields',
    );
  return route;
}

export interface GetStatusParams {
  txHash: string;
  fromChain: number;
  toChain: number;
  apiKey: string | undefined;
}

export async function fetchBridgeStatus(params: GetStatusParams): Promise<LifiStatusResponse> {
  const url = new URL(`${LIFI_API}/status`);
  url.searchParams.set('txHash', params.txHash);
  url.searchParams.set('fromChain', String(params.fromChain));
  url.searchParams.set('toChain', String(params.toChain));

  const json = await doFetch(
    url.toString(),
    { headers: apiHeaders(params.apiKey) },
    `fetchBridgeStatus(${params.txHash})`,
  );
  const parsed = LifiStatusResponseSchema.safeParse(json);
  if (!parsed.success)
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] fetchBridgeStatus: unexpected response shape — ${parsed.error.message}`,
    );
  return parsed.data;
}
