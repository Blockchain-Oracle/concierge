import type { Address } from 'viem';
import type { CHAIN_CONFIGS } from './constants.ts';

export type SupportedChain = keyof typeof CHAIN_CONFIGS;

/**
 * Intentionally minimal stub — callers needing the full KernelAccountClient
 * should cast: `account.kernelClient as KernelAccountClient`.
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
 * kernelClient   — cast to KernelAccountClient from @zerodev/sdk as needed;
 *                  throws ConciergeError('RpcError') if client init failed
 *
 * The opaque `object` types avoid viem peer-dep version skew in the DTS build.
 */
export interface ConciergeAccount {
  readonly smartAccountAddress: Address;
  readonly kernelAccount: KernelAccountStub & object;
  readonly kernelClient: KernelClientStub & object;
}
