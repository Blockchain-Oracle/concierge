import type { EvmChainId } from '@concierge/shared';
import { mantleMainnet } from '@concierge/shared';
import { createPublicClient, http, type PublicClient, type WalletClient } from 'viem';
import { type ActionContext, LIFI_DIAMOND } from './_context.ts';
import { createBridgeTool } from './actions/bridge.ts';
import { createGetStatusTool } from './actions/getStatus.ts';
import { createQuoteTool } from './actions/quote.ts';

export interface LifiBridgeProviderOptions {
  rpcUrl?: string;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  apiKey?: string;
  integrator?: string;
}

export interface LifiBridgeProvider {
  readonly chainId: EvmChainId;
  readonly actions: {
    readonly quote: ReturnType<typeof createQuoteTool>;
    readonly bridge: ReturnType<typeof createBridgeTool>;
    readonly getStatus: ReturnType<typeof createGetStatusTool>;
  };
}

export function createLifiBridgeProvider(opts: LifiBridgeProviderOptions = {}): LifiBridgeProvider {
  const viemChain = mantleMainnet;
  const chainId: EvmChainId = 5000;

  const publicClient: PublicClient =
    opts.publicClient ??
    createPublicClient({
      chain: viemChain,
      transport: http(opts.rpcUrl ?? 'https://rpc.mantle.xyz'),
    });

  const ctx: ActionContext = {
    publicClient,
    walletClient: opts.walletClient,
    chainId,
    apiKey: opts.apiKey,
    integrator: opts.integrator ?? 'concierge',
    lifiDiamond: LIFI_DIAMOND,
  };

  return Object.freeze({
    chainId,
    actions: Object.freeze({
      quote: createQuoteTool(ctx),
      bridge: createBridgeTool(ctx),
      getStatus: createGetStatusTool(ctx),
    }),
  });
}
