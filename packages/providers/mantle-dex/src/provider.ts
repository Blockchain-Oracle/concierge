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

function resolveChainId(opts: MantleDexProviderOptions): EvmChainId {
  if (opts.chain === 'mantle-mainnet') return 5000;
  if (opts.chain === 'mantle-sepolia') return 5003;
  if (opts.rpcUrl?.toLowerCase().includes('sepolia')) return 5003;
  if (opts.publicClient?.chain?.id === 5000 || opts.publicClient?.chain?.id === 5003) {
    return opts.publicClient.chain.id as EvmChainId;
  }
  if (opts.walletClient?.chain?.id === 5000 || opts.walletClient?.chain?.id === 5003) {
    return opts.walletClient.chain.id as EvmChainId;
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

  if (opts.walletClient?.chain) {
    const wcId = opts.walletClient.chain.id;
    if (wcId !== 5000 && wcId !== 5003) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/mantle-dex] walletClient chain id ${wcId} is not Mantle (5000 mainnet, 5003 sepolia).`,
      );
    }
  }

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
