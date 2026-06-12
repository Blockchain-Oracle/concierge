import { ConciergeError } from '@concierge/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import type { Address, LocalAccount } from 'viem';
import { createPublicClient, http, isAddress } from 'viem';
import { CHAIN_CONFIGS } from './constants.ts';
import type { ConciergeAccount, SupportedChain } from './types.ts';

export interface ConnectConciergeAccountConfig {
  address: Address;
  owner: LocalAccount;
  chain: SupportedChain;
}

const rpcWrap = (err: unknown) => {
  throw ConciergeError.fromUnknown(err, 'RpcError');
};

/**
 * Re-attach to a previously-deployed Kernel account at a known address.
 * No deployment transaction is fired — CREATE2 computes the same address
 * for the same owner + chain, so the account object is reconstructed locally.
 *
 * Note: ZeroDev echoes the supplied address back without cross-validating the
 * owner's CREATE2 derivation. Owner/address consistency is enforced at UserOp
 * submission time (EntryPoint AA24 signature error) rather than here.
 */
export async function connectToConciergeAccount(
  config: ConnectConciergeAccountConfig,
): Promise<ConciergeAccount> {
  if (!isAddress(config.address)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] connectToConciergeAccount: InvalidAddress('${config.address}') — must be a 42-char 0x-prefixed hex string.`,
    );
  }
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
    address: config.address,
  }).catch(rpcWrap);
  const smartAccountAddress = kernelAccount.address;
  const bundlerUrl = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  // new Promise() wraps createKernelAccountClient (synchronous) so that any
  // synchronous throw is promoted to a rejection — caught by .catch(rpcWrap).
  const clientPromise = new Promise<object>((resolve) =>
    resolve(
      createKernelAccountClient({
        account: kernelAccount,
        chain: chainConfig.chain,
        bundlerTransport: http(bundlerUrl),
        // biome-ignore lint/suspicious/noExplicitAny: publicClient type variance between viem peer dep versions
        client: publicClient as any,
      }),
    ),
  ).catch(rpcWrap);
  return { smartAccountAddress, kernelAccount, clientPromise };
}
