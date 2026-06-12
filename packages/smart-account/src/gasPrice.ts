import { ConciergeError } from '@concierge/sdk';
import { CHAIN_CONFIGS } from './constants.ts';
import type { SupportedChain } from './types.ts';

export interface UserOpGasPrice {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface GetUserOpGasPriceConfig {
  chain: SupportedChain;
  /** Defaults to `process.env.PIMLICO_API_KEY` */
  apiKey?: string;
}

type PimlicoGasPriceResult = {
  standard: { maxFeePerGas: string; maxPriorityFeePerGas: string };
};
type PimlicoRpcResponse = {
  result?: PimlicoGasPriceResult;
  error?: { code: number; message: string };
};

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
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: BundlerError({ status: ${res.status} })`,
    );
  }
  const data = (await res.json()) as PimlicoRpcResponse;
  if (data.error) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] getUserOpGasPrice: ${data.error.message}`,
    );
  }
  if (!data.result?.standard) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/smart-account] getUserOpGasPrice: unexpected response shape from pimlico_getUserOperationGasPrice',
    );
  }
  return {
    maxFeePerGas: BigInt(data.result.standard.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(data.result.standard.maxPriorityFeePerGas),
  };
}
