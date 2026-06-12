import { ConciergeError } from '@concierge/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import type { LocalAccount } from 'viem';
import { createPublicClient, http } from 'viem';
import { CHAIN_CONFIGS } from './constants.ts';
import { createPaymasterClient } from './paymaster.ts';
import type { ConciergeAccount, KernelClientStub, SupportedChain } from './types.ts';

export interface CreateConciergeAccountConfig {
  owner: LocalAccount;
  chain: SupportedChain;
  /**
   * Paymaster strategy. Defaults to 'pimlico' (sponsored) on mantle-sepolia
   * and 'none' (user pays MNT) on mantle-mainnet.
   * Note: PIMLICO_API_KEY (or apiKey) is required regardless — the Pimlico
   * bundler authenticates all requests, not just sponsored ones.
   */
  paymaster?: 'pimlico' | 'none';
  /** Pimlico API key. Defaults to `process.env.PIMLICO_API_KEY`. */
  apiKey?: string;
}

const rpcWrap = (err: unknown) => {
  throw ConciergeError.fromUnknown(err, 'RpcError');
};

export async function createConciergeAccount(
  config: CreateConciergeAccountConfig,
): Promise<ConciergeAccount> {
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createConciergeAccount: UnsupportedChain('${config.chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = config.apiKey ?? process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] createConciergeAccount: MissingEnvVar('PIMLICO_API_KEY') — set this env var or pass apiKey in config before creating a smart account.",
    );
  }
  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: http(chainConfig.chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint('0.7');
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    // biome-ignore lint/suspicious/noExplicitAny: Signer union from @zerodev/sdk accepts LocalAccount; cast avoids peer dep version skew
    signer: config.owner as any,
    entryPoint,
    kernelVersion: KERNEL_V3_1,
  }).catch(rpcWrap);
  const kernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
  }).catch(rpcWrap);
  const smartAccountAddress = kernelAccount.address;
  const bundlerUrl = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  const paymasterStrategy =
    config.paymaster ?? (config.chain === 'mantle-sepolia' ? 'pimlico' : 'none');
  const paymasterClient = createPaymasterClient(
    paymasterStrategy === 'pimlico'
      ? { chain: config.chain, sponsorshipPolicy: 'always', apiKey }
      : { chain: config.chain, sponsorshipPolicy: 'never' },
  );
  let kernelClient: KernelClientStub & object;
  try {
    kernelClient = createKernelAccountClient({
      account: kernelAccount,
      chain: chainConfig.chain,
      bundlerTransport: http(bundlerUrl),
      // biome-ignore lint/suspicious/noExplicitAny: publicClient type variance between viem peer dep versions
      client: publicClient as any,
      ...(paymasterClient && {
        paymaster: {
          getPaymasterData: paymasterClient.getPaymasterData,
          getPaymasterStubData: paymasterClient.getPaymasterStubData,
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: KernelAccountClient satisfies KernelClientStub at runtime; cast avoids viem peer-dep version skew
    }) as any;
  } catch (err) {
    throw ConciergeError.fromUnknown(err, 'RpcError');
  }
  return { smartAccountAddress, kernelAccount, kernelClient };
}
