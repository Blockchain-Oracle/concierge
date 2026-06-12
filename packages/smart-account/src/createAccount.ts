import { ConciergeError } from '@concierge/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import type { LocalAccount } from 'viem';
import { createPublicClient, http } from 'viem';
import { CHAIN_CONFIGS } from './constants.ts';
import type { ConciergeAccount } from './types.ts';

export interface CreateConciergeAccountConfig {
  owner: LocalAccount;
  chain: keyof typeof CHAIN_CONFIGS;
}

export async function createConciergeAccount(
  config: CreateConciergeAccountConfig,
): Promise<ConciergeAccount> {
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createConciergeAccount: UnsupportedChain('${config.chain}')`,
    );
  }
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] createConciergeAccount: MissingEnvVar('PIMLICO_API_KEY') — set this env var before creating a smart account. Without it, UserOp submissions fail with a cryptic 401.",
    );
  }
  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: http(chainConfig.chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint('0.7');
  const rpcWrap = (err: unknown) => {
    throw ConciergeError.fromUnknown(err, 'RpcError');
  };
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
  const clientPromise = Promise.resolve(
    createKernelAccountClient({
      account: kernelAccount,
      chain: chainConfig.chain,
      bundlerTransport: http(bundlerUrl),
      // biome-ignore lint/suspicious/noExplicitAny: publicClient type variance between viem peer dep versions
      client: publicClient as any,
    }),
  ).catch(rpcWrap);
  return { smartAccountAddress, kernelAccount, clientPromise };
}
