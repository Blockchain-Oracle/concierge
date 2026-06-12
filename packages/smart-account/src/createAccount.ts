import { ConciergeError } from '@concierge/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import type { LocalAccount } from 'viem';
import { createPublicClient, http } from 'viem';
import type { CHAIN_CONFIGS } from './constants.ts';
import { resolveChainConfig, rpcCatch } from './internal.ts';
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

function resolveCreateConfig(config: CreateConciergeAccountConfig): {
  chainConfig: (typeof CHAIN_CONFIGS)[keyof typeof CHAIN_CONFIGS];
  apiKey: string;
  bundlerUrl: string;
} {
  return resolveChainConfig(
    'createConciergeAccount',
    config.chain,
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    config.apiKey ?? process.env['PIMLICO_API_KEY'],
  );
}

export async function createConciergeAccount(
  config: CreateConciergeAccountConfig,
): Promise<ConciergeAccount> {
  const { chainConfig, apiKey, bundlerUrl } = resolveCreateConfig(config);
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
  }).catch(rpcCatch('createConciergeAccount: ECDSA validator init failed', config.chain));
  const kernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
  }).catch(rpcCatch('createConciergeAccount: kernel account init failed', config.chain));
  const smartAccountAddress = kernelAccount.address;
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
    }) as unknown as KernelClientStub & object;
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] createConciergeAccount: kernel client init failed (chain: '${config.chain}')`,
      err,
    );
  }
  return { smartAccountAddress, kernelAccount, kernelClient };
}
