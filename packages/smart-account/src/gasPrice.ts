import { ConciergeError } from '@concierge/sdk';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

export interface UserOpGasPrice {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** Unix timestamp (ms) when this snapshot was fetched. Gas prices change per block — do not cache. */
  readonly fetchedAt: number;
}

export interface GetUserOpGasPriceConfig {
  chain: SupportedChain;
  /** Defaults to `process.env.PIMLICO_API_KEY` */
  apiKey?: string;
}

type PimlicoGasPriceTier = { maxFeePerGas: string; maxPriorityFeePerGas: string };
type PimlicoRpcResponse =
  | {
      result: {
        slow: PimlicoGasPriceTier;
        standard: PimlicoGasPriceTier;
        fast: PimlicoGasPriceTier;
      };
      error?: undefined;
    }
  | { result?: undefined; error: { code: number; message: string } };

function parseTier(
  data: PimlicoRpcResponse,
  chain: SupportedChain,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (data.error) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: ${data.error.message}`,
    );
  }
  if (!data.result?.standard) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: unexpected response shape from pimlico_getUserOperationGasPrice (chain: '${chain}')`,
    );
  }
  const { maxFeePerGas: rawMax, maxPriorityFeePerGas: rawPriority } = data.result.standard;
  if (typeof rawMax !== 'string' || typeof rawPriority !== 'string') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: unexpected field types — expected hex strings, got maxFeePerGas=${typeof rawMax} maxPriorityFeePerGas=${typeof rawPriority}`,
    );
  }
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    maxFeePerGas = BigInt(rawMax);
    maxPriorityFeePerGas = BigInt(rawPriority);
  } catch (_err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: BigInt conversion failed — maxFeePerGas="${rawMax}" maxPriorityFeePerGas="${rawPriority}"`,
    );
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: EIP-1559 invariant violated — maxPriorityFeePerGas (${maxPriorityFeePerGas}) > maxFeePerGas (${maxFeePerGas})`,
    );
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Queries Pimlico's gas price oracle for current UserOp gas prices.
 * Must be called fresh per UserOp — gas prices change block-to-block.
 */
export async function getUserOpGasPrice(config: GetUserOpGasPriceConfig): Promise<UserOpGasPrice> {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = config.apiKey ?? process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] getUserOpGasPrice: MissingEnvVar('PIMLICO_API_KEY') — set this env var before querying gas price.",
    );
  }
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] getUserOpGasPrice: UnsupportedChain('${config.chain}')`,
    );
  }
  const url = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'pimlico_getUserOperationGasPrice',
        params: [],
      }),
    });
  } catch (err) {
    throw ConciergeError.fromUnknown(err, 'RpcError');
  }
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* body unreadable */
    }
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: BundlerError({ status: ${res.status}, chain: '${config.chain}' })${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }
  let data: PimlicoRpcResponse;
  try {
    data = (await res.json()) as PimlicoRpcResponse;
  } catch (_err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: failed to parse JSON response from Pimlico (chain: '${config.chain}') — body may not be JSON`,
    );
  }
  const { maxFeePerGas, maxPriorityFeePerGas } = parseTier(data, config.chain);
  return { maxFeePerGas, maxPriorityFeePerGas, fetchedAt: Date.now() };
}
