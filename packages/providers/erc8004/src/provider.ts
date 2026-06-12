import { ADDRESSES, type Address, mantleMainnet, mantleSepolia } from '@concierge/shared';
import { createPublicClient, http, type PublicClient, type WalletClient } from 'viem';
import type { ActionContext } from './_context.ts';
import { createAttestActionTool } from './actions/attestAction.ts';
import { createReadFeedbackTool } from './actions/readFeedback.ts';
import { createReadReputationTool } from './actions/readReputation.ts';
import { createRegisterAgentTool } from './actions/registerAgent.ts';

export type Erc8004Chain = 'mantle-mainnet' | 'mantle-sepolia';

export interface Erc8004ProviderOptions {
  chain?: Erc8004Chain;
  rpcUrl?: string;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  /** Override identity registry address (advanced; prefer canonical defaults). */
  identityRegistry?: Address;
  /** Override reputation registry address (advanced; prefer canonical defaults). */
  reputationRegistry?: Address;
}

export interface Erc8004Provider {
  readonly chainId: 5000 | 5003;
  readonly identityRegistry: Address;
  readonly reputationRegistry: Address;
  readonly actions: {
    readonly registerAgent: ReturnType<typeof createRegisterAgentTool>;
    readonly attestAction: ReturnType<typeof createAttestActionTool>;
    readonly readReputation: ReturnType<typeof createReadReputationTool>;
    readonly readFeedback: ReturnType<typeof createReadFeedbackTool>;
  };
}

export function createErc8004Provider(opts: Erc8004ProviderOptions = {}): Erc8004Provider {
  const chain = opts.chain ?? 'mantle-mainnet';
  const isMainnet = chain === 'mantle-mainnet';
  const chainId: 5000 | 5003 = isMainnet ? 5000 : 5003;
  const viemChain = isMainnet ? mantleMainnet : mantleSepolia;

  const defaultRpc = isMainnet ? 'https://rpc.mantle.xyz' : 'https://rpc.sepolia.mantle.xyz';
  const addresses = isMainnet ? ADDRESSES.mantleMainnet : ADDRESSES.mantleSepolia;

  const identityRegistry: Address = opts.identityRegistry ?? addresses.erc8004.identityRegistry;
  const reputationRegistry: Address =
    opts.reputationRegistry ?? addresses.erc8004.reputationRegistry;

  const publicClient: PublicClient =
    opts.publicClient ??
    createPublicClient({
      chain: viemChain,
      transport: http(opts.rpcUrl ?? defaultRpc),
    });

  const ctx: ActionContext = {
    publicClient,
    walletClient: opts.walletClient,
    identityRegistry,
    reputationRegistry,
    chainId,
  };

  return Object.freeze({
    chainId,
    identityRegistry,
    reputationRegistry,
    actions: Object.freeze({
      registerAgent: createRegisterAgentTool(ctx),
      attestAction: createAttestActionTool(ctx),
      readReputation: createReadReputationTool(ctx),
      readFeedback: createReadFeedbackTool(ctx),
    }),
  });
}
