import type { Address } from 'viem';
import type { CHAIN_CONFIGS } from './constants.ts';

export type SupportedChain = keyof typeof CHAIN_CONFIGS;

/**
 * Intentionally minimal stub — callers needing the full KernelAccountClient
 * should cast: `(await account.clientPromise) as KernelAccountClient`.
 * The opaque `object` in ConciergeAccount avoids viem peer-dep version skew
 * in the DTS build (ZeroDev SDK compiled against viem 2.38; project uses 2.52).
 */
export interface KernelClientStub {
  readonly chain: { readonly id: number };
}

/**
 * Intentionally minimal stub of CreateKernelAccountReturnType from @zerodev/sdk.
 * Same viem version-skew rationale as KernelClientStub.
 */
export interface KernelAccountStub {
  readonly address: Address;
}

/**
 * Core account bundle returned by createConciergeAccount / connectToConciergeAccount.
 *
 * kernelAccount  — cast to CreateKernelAccountReturnType from @zerodev/sdk as needed
 * clientPromise  — cast to KernelAccountClient from @zerodev/sdk as needed;
 *                  rejects with ConciergeError('RpcError') if client init fails
 *
 * The opaque `object` types avoid viem peer-dep version skew in the DTS build.
 */
export interface ConciergeAccount {
  readonly smartAccountAddress: Address;
  readonly kernelAccount: KernelAccountStub & object;
  readonly clientPromise: Promise<object>;
}
