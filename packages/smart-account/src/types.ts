import type { Address } from 'viem';
import type { CHAIN_CONFIGS } from './constants.ts';

export type SupportedChain = keyof typeof CHAIN_CONFIGS;

/**
 * Core account bundle returned by createConciergeAccount / connectToConciergeAccount.
 *
 * kernelAccount  — cast to CreateKernelAccountReturnType from @zerodev/sdk as needed
 * clientPromise  — cast to KernelAccountClient from @zerodev/sdk as needed
 *
 * The opaque `object` types avoid a viem peer-dep version skew in the DTS build;
 * ZeroDev SDK ships types compiled against viem 2.38 while the project uses viem 2.52.
 */
export interface ConciergeAccount {
  readonly smartAccountAddress: Address;
  readonly kernelAccount: { readonly address: Address } & object;
  readonly clientPromise: Promise<object>;
}
