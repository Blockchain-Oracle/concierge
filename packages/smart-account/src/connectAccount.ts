import { ConciergeError } from '@concierge/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { getEntryPoint, KERNEL_V3_1 } from '@zerodev/sdk/constants';
import type { Address, LocalAccount } from 'viem';
import { createPublicClient, http, isAddress } from 'viem';
import { CHAIN_CONFIGS } from './constants.ts';
import { createPaymasterClient } from './paymaster.ts';
import type { ConciergeAccount, KernelClientStub, SupportedChain } from './types.ts';

export interface ConnectConciergeAccountConfig {
  address: Address;
  owner: LocalAccount;
  chain: SupportedChain;
  /**
   * Paymaster strategy. Defaults to 'pimlico' (sponsored) on mantle-sepolia
   * and 'none' (user pays MNT) on mantle-mainnet — mirrors createConciergeAccount.
   * Note: PIMLICO_API_KEY (or apiKey) is required regardless.
   */
  paymaster?: 'pimlico' | 'none';
  /** Pimlico API key. Defaults to `process.env.PIMLICO_API_KEY`. */
  apiKey?: string;
}

function rpcCatch(op: string, chain: string) {
  return (err: unknown): never => {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] ${op} (chain: '${chain}')`,
      err,
    );
  };
}

function validateConnectConfig(config: ConnectConciergeAccountConfig): {
  chainConfig: (typeof CHAIN_CONFIGS)[keyof typeof CHAIN_CONFIGS];
  bundlerUrl: string;
  apiKey: string;
} {
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
      `[@concierge/smart-account] connectToConciergeAccount: UnsupportedChain('${config.chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  const apiKey = config.apiKey ?? process.env['PIMLICO_API_KEY'];
  if (!apiKey) {
    throw new ConciergeError(
      'ConfigError',
      "[@concierge/smart-account] connectToConciergeAccount: MissingEnvVar('PIMLICO_API_KEY') — set this env var or pass apiKey in config before connecting to a smart account.",
    );
  }
  const bundlerUrl = `${chainConfig.bundlerBaseUrl}?apikey=${apiKey}`;
  return { chainConfig, bundlerUrl, apiKey };
}

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
  const { chainConfig, bundlerUrl, apiKey } = validateConnectConfig(config);
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
  }).catch(rpcCatch('connectToConciergeAccount: ECDSA validator init failed', config.chain));
  const kernelAccount = await createKernelAccount(publicClient, {
    plugins: { sudo: ecdsaValidator },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
    address: config.address,
  }).catch(rpcCatch('connectToConciergeAccount: kernel account init failed', config.chain));
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
      `[@concierge/smart-account] connectToConciergeAccount: kernel client init failed (chain: '${config.chain}')`,
      err,
    );
  }
  return { smartAccountAddress, kernelAccount, kernelClient };
}
