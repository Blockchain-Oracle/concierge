import {
  type Address,
  addressesFor,
  type EvmChainId,
  mantleMainnet,
  mantleSepolia,
} from '@concierge/shared';
import { type Chain, createPublicClient, http, type PublicClient, type WalletClient } from 'viem';
import type { ActionContext } from './_context.ts';
import { createBorrowTool } from './actions/borrow.ts';
import { createClaimRewardsTool } from './actions/claimRewards.ts';
import { createRepayTool } from './actions/repay.ts';
import { createSetUserEModeTool } from './actions/setUserEMode.ts';
import { createSupplyTool } from './actions/supply.ts';
import { createWithdrawTool } from './actions/withdraw.ts';

// Verified on-chain 2026-06-03 (research/concierge/03-providers/aave-v3-mantle.md)
const MAINNET_INCENTIVES_CONTROLLER = '0x682482a584eE20fefc01f4575c45C5d84de6F619' as Address;

export interface AaveV3MantleAddressOverrides {
  pool?: Address;
  oracle?: Address;
  incentivesController?: Address;
  // Only sUSDe is consumed by the provider (E-Mode preflight). Add other token overrides here as actions are added.
  sUsde?: Address;
}

export interface AaveV3MantleProviderOpts {
  walletClient?: WalletClient | undefined;
  publicClient?: PublicClient | undefined;
  rpcUrl?: string | undefined;
  chain?: 'mantle-mainnet' | 'mantle-sepolia' | Chain | undefined;
  /** Override addresses for testing (e.g. mock contracts on an Anvil fork). */
  addresses?: AaveV3MantleAddressOverrides | undefined;
}

export interface AaveV3MantleProvider {
  readonly chainId: EvmChainId;
  readonly actions: {
    readonly supply: ReturnType<typeof createSupplyTool>;
    readonly borrow: ReturnType<typeof createBorrowTool>;
    readonly repay: ReturnType<typeof createRepayTool>;
    readonly withdraw: ReturnType<typeof createWithdrawTool>;
    readonly setUserEMode: ReturnType<typeof createSetUserEModeTool>;
    readonly claimRewards: ReturnType<typeof createClaimRewardsTool>;
  };
}

function resolveChain(opts: AaveV3MantleProviderOpts): { viemChain: Chain; chainId: EvmChainId } {
  if (opts.walletClient?.chain) {
    const id = opts.walletClient.chain.id as EvmChainId;
    return { viemChain: opts.walletClient.chain, chainId: id };
  }
  if (opts.chain) {
    if (opts.chain === 'mantle-mainnet') return { viemChain: mantleMainnet, chainId: 5000 };
    if (opts.chain === 'mantle-sepolia') return { viemChain: mantleSepolia, chainId: 5003 };
    const id = opts.chain.id as EvmChainId;
    return { viemChain: opts.chain, chainId: id };
  }
  // Infer from rpcUrl pattern; fall back to mainnet.
  if (opts.rpcUrl?.includes('sepolia')) return { viemChain: mantleSepolia, chainId: 5003 };
  return { viemChain: mantleMainnet, chainId: 5000 };
}

export function createAaveV3MantleProvider(
  opts: AaveV3MantleProviderOpts = {},
): AaveV3MantleProvider {
  const { viemChain, chainId } = resolveChain(opts);

  const transport = http(opts.rpcUrl ?? viemChain.rpcUrls.default.http[0]);
  const publicClient = opts.publicClient ?? createPublicClient({ chain: viemChain, transport });

  const sharedAddrs = addressesFor(chainId);
  const ov = opts.addresses;

  const poolAddress = ov?.pool ?? sharedAddrs.aave.pool;
  const oracleAddress = ov?.oracle ?? sharedAddrs.aave.oracle;
  // Sepolia: incentives controller not deployed — claimRewards will throw NotSupportedOnChain.
  const incentivesControllerAddress: Address | undefined =
    ov?.incentivesController ?? (chainId === 5000 ? MAINNET_INCENTIVES_CONTROLLER : undefined);
  const sUsdeAddress = ov?.sUsde ?? sharedAddrs.tokens.sUSDe;

  const ctx: ActionContext = {
    publicClient,
    walletClient: opts.walletClient,
    chainId,
    poolAddress,
    oracleAddress,
    incentivesControllerAddress,
    sUsdeAddress,
  };

  return Object.freeze({
    chainId,
    actions: Object.freeze({
      supply: createSupplyTool(ctx),
      borrow: createBorrowTool(ctx),
      repay: createRepayTool(ctx),
      withdraw: createWithdrawTool(ctx),
      setUserEMode: createSetUserEModeTool(ctx),
      claimRewards: createClaimRewardsTool(ctx),
    }),
  });
}
