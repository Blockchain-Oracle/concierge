import { ConciergeError } from '@concierge/sdk';
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

const SUPPORTED_CHAIN_IDS = new Set([5000, 5003]);

function resolveChain(opts: AaveV3MantleProviderOpts): { viemChain: Chain; chainId: EvmChainId } {
  if (opts.walletClient?.chain) {
    const id = opts.walletClient.chain.id;
    if (!SUPPORTED_CHAIN_IDS.has(id)) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/aave-v3-mantle] expected Mantle Mainnet (5000) or Mantle Sepolia (5003), got chainId ${id}. Connect a Mantle wallet or pass chain: "mantle-mainnet".`,
        undefined,
        { chainId: id },
      );
    }
    return { viemChain: opts.walletClient.chain, chainId: id as EvmChainId };
  }
  if (opts.chain) {
    if (opts.chain === 'mantle-mainnet') return { viemChain: mantleMainnet, chainId: 5000 };
    if (opts.chain === 'mantle-sepolia') return { viemChain: mantleSepolia, chainId: 5003 };
    // Custom Chain object (e.g. Anvil fork with address overrides): trust the caller.
    const id = opts.chain.id as EvmChainId;
    return { viemChain: opts.chain, chainId: id };
  }
  // rpcUrl heuristic — best-effort only; non-standard URLs should pass chain explicitly.
  if (opts.rpcUrl?.includes('sepolia')) return { viemChain: mantleSepolia, chainId: 5003 };
  return { viemChain: mantleMainnet, chainId: 5000 };
}

export function createAaveV3MantleProvider(
  opts: AaveV3MantleProviderOpts = {},
): AaveV3MantleProvider {
  const { viemChain, chainId } = resolveChain(opts);

  const transport = http(opts.rpcUrl ?? viemChain.rpcUrls.default.http[0]);
  const publicClient = opts.publicClient ?? createPublicClient({ chain: viemChain, transport });

  // addressesFor throws for custom chains (e.g. Anvil forks) — only call it for known chain IDs.
  const sharedAddrs = SUPPORTED_CHAIN_IDS.has(chainId) ? addressesFor(chainId) : undefined;
  const ov = opts.addresses;

  const poolAddress = ov?.pool ?? sharedAddrs?.aave.pool;
  const oracleAddress = ov?.oracle ?? sharedAddrs?.aave.oracle;
  if (!poolAddress || !oracleAddress) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/aave-v3-mantle] pool and oracle addresses are required for custom chains. Pass addresses: { pool, oracle } in AaveV3MantleProviderOpts.`,
    );
  }
  // Sepolia: incentives controller not deployed — claimRewards will throw NetworkUnsupported.
  const incentivesControllerAddress: Address | undefined =
    ov?.incentivesController ?? (chainId === 5000 ? MAINNET_INCENTIVES_CONTROLLER : undefined);
  const sUsdeAddress = ov?.sUsde ?? sharedAddrs?.tokens.sUSDe;
  if (!sUsdeAddress) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/aave-v3-mantle] sUsde address is required for custom chains. Pass addresses: { sUsde } in AaveV3MantleProviderOpts.`,
    );
  }

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
