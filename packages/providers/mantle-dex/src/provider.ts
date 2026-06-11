import { ConciergeError } from '@concierge/sdk';
import type { EvmChainId } from '@concierge/shared';
import { addressesFor, mantleMainnet, mantleSepolia } from '@concierge/shared';
import type { PublicClient, WalletClient } from 'viem';
import { createPublicClient, http } from 'viem';
import type { ActionContext } from './_context.ts';
import { createQuoteTool } from './actions/quote.ts';
import { createSwapTool } from './actions/swap.ts';

export interface MantleDexProviderOptions {
  chain?: 'mantle-mainnet' | 'mantle-sepolia';
  rpcUrl?: string;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}

export interface MantleDexProvider {
  readonly chainId: EvmChainId;
  readonly actions: {
    readonly quote: ReturnType<typeof createQuoteTool>;
    readonly swap: ReturnType<typeof createSwapTool>;
  };
}

const MANTLE_CHAIN_IDS = new Set([5000, 5003]);

function resolveChainId(opts: MantleDexProviderOptions): EvmChainId {
  if (opts.chain === 'mantle-mainnet') return 5000;
  if (opts.chain === 'mantle-sepolia') return 5003;
  if (opts.rpcUrl?.toLowerCase().includes('sepolia')) return 5003;

  const pcId = opts.publicClient?.chain?.id;
  if (pcId !== undefined) {
    if (!MANTLE_CHAIN_IDS.has(pcId)) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/mantle-dex] publicClient chain id ${pcId} is not Mantle (5000 mainnet, 5003 sepolia).`,
      );
    }
    return pcId as EvmChainId;
  }

  const wcId = opts.walletClient?.chain?.id;
  if (wcId !== undefined) {
    if (!MANTLE_CHAIN_IDS.has(wcId)) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/mantle-dex] walletClient chain id ${wcId} is not Mantle (5000 mainnet, 5003 sepolia).`,
      );
    }
    return wcId as EvmChainId;
  }

  return 5000;
}

export function createMantleDexProvider(opts: MantleDexProviderOptions = {}): MantleDexProvider {
  const chainId = resolveChainId(opts);
  const viemChain = chainId === 5003 ? mantleSepolia : mantleMainnet;

  const publicClient: PublicClient =
    opts.publicClient ??
    createPublicClient({
      chain: viemChain,
      transport: http(
        opts.rpcUrl ??
          (chainId === 5003 ? 'https://rpc.sepolia.mantle.xyz' : 'https://rpc.mantle.xyz'),
      ),
    });

  const net = addressesFor(chainId);
  const dex = net.mantleDex;

  const ctx: ActionContext = {
    publicClient,
    walletClient: opts.walletClient,
    chainId,
    addresses: {
      merchantMoe: {
        lbRouter: dex.merchantMoe.lbRouter,
        lbQuoter: dex.merchantMoe.lbQuoter,
      },
      agni: {
        swapRouter: dex.agni.swapRouter,
        quoterV2: dex.agni.quoterV2,
      },
      fusionx: {
        swapRouter: dex.fusionx.swapRouter,
        quoterV2: dex.fusionx.quoterV2,
      },
      woofi: {
        router: dex.woofi.router,
        pool: dex.woofi.pool,
      },
      lifi: { diamond: net.lifi.diamond },
    },
  };

  return Object.freeze({
    chainId,
    actions: Object.freeze({
      quote: createQuoteTool(ctx),
      swap: createSwapTool(ctx),
    }),
  });
}
