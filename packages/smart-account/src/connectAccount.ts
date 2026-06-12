import { ConciergeError } from '@concierge/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import type { Address, LocalAccount } from 'viem';
import { createPublicClient, http } from 'viem';
import { CHAIN_CONFIGS } from './constants.ts';
import type { ConciergeAccount } from './types.ts';

export interface ConnectConciergeAccountConfig {
  address: Address;
  owner: LocalAccount;
  chain: keyof typeof CHAIN_CONFIGS;
}

/**
 * Re-attach to a previously-deployed Kernel account at a known address.
 * No deployment transaction is fired — CREATE2 computes the same address
 * for the same owner + chain, so the account object is reconstructed locally.
 */
export async function connectToConciergeAccount(
  config: ConnectConciergeAccountConfig,
): Promise<ConciergeAccount> {
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] connectToConciergeAccount: UnsupportedChain('${config.chain}')`,
    );
  }
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] connectToConciergeAccount: MissingEnvVar('PIMLICO_API_KEY') — set this env var before connecting to a smart account. Without it, UserOp submissions fail with a cryptic 401.",
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
  // Pass the known address so ZeroDev uses it directly (CREATE2-resolved) rather than re-computing.
  const kernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
    address: config.address,
  }).catch(rpcWrap);
  // Sanity-check: ZeroDev must honour the provided address override.
  if (kernelAccount.address.toLowerCase() !== config.address.toLowerCase()) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] connectToConciergeAccount: AddressMismatch — provided ${config.address} does not match ZeroDev-derived ${kernelAccount.address} for this owner on '${config.chain}'.`,
      undefined,
      { provided: config.address, computed: kernelAccount.address, chain: config.chain },
    );
  }
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
