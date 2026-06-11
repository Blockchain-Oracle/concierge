import { ConciergeError } from '@concierge/sdk';
import {
  type Address,
  addressesFor,
  type EvmChainId,
  mantleMainnet,
  mantleSepolia,
  ZERO_ADDRESS,
} from '@concierge/shared';
import { type Chain, createPublicClient, http, type PublicClient, type WalletClient } from 'viem';
import type { ActionContext, EthenaAddresses } from './_context.ts';
import { createGetCarryVsAaveTool } from './actions/getCarryVsAave.ts';
import { createGetYieldRateTool } from './actions/getYieldRate.ts';
import { createUnwrapToUSDeTool } from './actions/unwrapToUSDe.ts';
import { createWrapToSusdeTool } from './actions/wrapToSusde.ts';

export interface EthenaSusdeAddressOverrides {
  usde?: Address;
  susde?: Address;
  usdc?: Address;
  aavePool?: Address;
  aaveOracle?: Address;
  woofiRouter?: Address;
}

export interface EthenaSusdeProviderOpts {
  walletClient?: WalletClient | undefined;
  publicClient?: PublicClient | undefined;
  rpcUrl?: string | undefined;
  chain?: 'mantle-mainnet' | 'mantle-sepolia' | Chain | undefined;
  addresses?: EthenaSusdeAddressOverrides | undefined;
}

export interface EthenaSusdeProvider {
  readonly chainId: EvmChainId;
  readonly actions: {
    readonly getYieldRate: ReturnType<typeof createGetYieldRateTool>;
    readonly getCarryVsAave: ReturnType<typeof createGetCarryVsAaveTool>;
    readonly wrapToSusde: ReturnType<typeof createWrapToSusdeTool>;
    readonly unwrapToUSDe: ReturnType<typeof createUnwrapToUSDeTool>;
  };
}

const SUPPORTED_CHAIN_IDS = new Set([5000, 5003]);

function resolveChain(opts: EthenaSusdeProviderOpts): { viemChain: Chain; chainId: EvmChainId } {
  if (opts.walletClient?.chain) {
    const id = opts.walletClient.chain.id;
    if (!SUPPORTED_CHAIN_IDS.has(id)) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/ethena-susde] expected Mantle Mainnet (5000) or Mantle Sepolia (5003), got chainId ${id}.`,
        undefined,
        { chainId: id },
      );
    }
    return { viemChain: opts.walletClient.chain, chainId: id as EvmChainId };
  }
  if (opts.chain) {
    if (opts.chain === 'mantle-mainnet') return { viemChain: mantleMainnet, chainId: 5000 };
    if (opts.chain === 'mantle-sepolia') return { viemChain: mantleSepolia, chainId: 5003 };
    const id = opts.chain.id as EvmChainId;
    return { viemChain: opts.chain, chainId: id };
  }
  if (opts.rpcUrl?.includes('sepolia')) return { viemChain: mantleSepolia, chainId: 5003 };
  return { viemChain: mantleMainnet, chainId: 5000 };
}

export function createEthenaSusdeProvider(opts: EthenaSusdeProviderOpts = {}): EthenaSusdeProvider {
  const { viemChain, chainId } = resolveChain(opts);
  const transport = http(opts.rpcUrl ?? viemChain.rpcUrls.default.http[0]);
  const publicClient = opts.publicClient ?? createPublicClient({ chain: viemChain, transport });

  const sharedAddrs = SUPPORTED_CHAIN_IDS.has(chainId) ? addressesFor(chainId) : undefined;
  const ov = opts.addresses ?? {};

  const addresses: EthenaAddresses = {
    usde: ov.usde ?? sharedAddrs?.tokens.USDe ?? ZERO_ADDRESS,
    susde: ov.susde ?? sharedAddrs?.tokens.sUSDe ?? ZERO_ADDRESS,
    usdc: ov.usdc ?? sharedAddrs?.tokens.USDC ?? ZERO_ADDRESS,
    aavePool: ov.aavePool ?? sharedAddrs?.aave.pool ?? ZERO_ADDRESS,
    aaveOracle: ov.aaveOracle ?? sharedAddrs?.aave.oracle ?? ZERO_ADDRESS,
    woofiRouter: ov.woofiRouter ?? sharedAddrs?.mantleDex.woofi.router ?? ZERO_ADDRESS,
  };

  const requiredKeys = ['usde', 'susde', 'usdc', 'aavePool', 'aaveOracle', 'woofiRouter'] as const;
  for (const key of requiredKeys) {
    if (addresses[key] === ZERO_ADDRESS) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/ethena-susde] address "${key}" is zero. Pass addresses: { ${key} } for custom chains.`,
      );
    }
  }

  const ctx: ActionContext = {
    publicClient,
    walletClient: opts.walletClient,
    chainId,
    addresses,
  };

  return Object.freeze({
    chainId,
    actions: Object.freeze({
      getYieldRate: createGetYieldRateTool(ctx),
      getCarryVsAave: createGetCarryVsAaveTool(ctx),
      wrapToSusde: createWrapToSusdeTool(ctx),
      unwrapToUSDe: createUnwrapToUSDeTool(ctx),
    }),
  });
}
