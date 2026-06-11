import { ConciergeError } from '@concierge/sdk';
import { addressesFor, type EvmChainId, mantleMainnet, ZERO_ADDRESS } from '@concierge/shared';
import { type Chain, createPublicClient, http, type PublicClient } from 'viem';
import type { ActionContext, OndoAddresses } from './_context.ts';
import { createGetBalanceTool } from './actions/getBalance.ts';
import { createGetRateAccrualTool } from './actions/getRateAccrual.ts';
import { createGetYieldRateTool } from './actions/getYieldRate.ts';
import { isUserEligible } from './selectors.ts';

// Mantle Mainnet — verified on-chain 2026-06-11.
// Agni USDY/USDC pool (500 bps fee): 0xFF74722c79F7780D02967001c4E2C0E850f11810
// USDY blocklist contract: 0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6
const MANTLE_AGNI_USDY_USDC = '0xFF74722c79F7780D02967001c4E2C0E850f11810' as const;
const MANTLE_USDY_BLOCKLIST = '0xdBd7a7d8807f0C98c9A58f7732f2799c8587e5c6' as const;

export type OndoAddressOverrides = Partial<OndoAddresses>;

export interface OndoUsdyProviderOpts {
  publicClient?: PublicClient | undefined;
  rpcUrl?: string | undefined;
  chain?: 'mantle-mainnet' | Chain | undefined;
  addresses?: OndoAddressOverrides | undefined;
}

export interface OndoUsdyProvider {
  readonly chainId: 5000;
  readonly actions: {
    readonly getBalance: ReturnType<typeof createGetBalanceTool>;
    readonly getRateAccrual: ReturnType<typeof createGetRateAccrualTool>;
    readonly getYieldRate: ReturnType<typeof createGetYieldRateTool>;
  };
  readonly selectors: {
    readonly isUserEligible: (user: `0x${string}`) => Promise<boolean>;
  };
}

const SUPPORTED_CHAIN_ID = 5000 as const;

function resolveChain(opts: OndoUsdyProviderOpts): { viemChain: Chain; chainId: EvmChainId } {
  if (opts.chain) {
    if (opts.chain === 'mantle-mainnet') return { viemChain: mantleMainnet, chainId: 5000 };
    const id = opts.chain.id;
    if (id !== SUPPORTED_CHAIN_ID) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/ondo-usdy] expected Mantle Mainnet (5000), got chainId ${id}.`,
        undefined,
        { chainId: id },
      );
    }
    return { viemChain: opts.chain, chainId: id as EvmChainId };
  }
  return { viemChain: mantleMainnet, chainId: 5000 };
}

export function createOndoUsdyProvider(opts: OndoUsdyProviderOpts = {}): OndoUsdyProvider {
  const { viemChain, chainId } = resolveChain(opts);
  const transport = http(opts.rpcUrl ?? viemChain.rpcUrls.default.http[0]);
  const publicClient = opts.publicClient ?? createPublicClient({ chain: viemChain, transport });

  let sharedAddrs: ReturnType<typeof addressesFor> | undefined;
  try {
    sharedAddrs = addressesFor(chainId);
  } catch (err) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/ondo-usdy] failed to load shared addresses for chainId ${chainId}`,
      err instanceof Error ? err : undefined,
    );
  }

  const ov = opts.addresses ?? {};
  const addresses: OndoAddresses = {
    usdy: ov.usdy ?? sharedAddrs?.tokens.USDY ?? ZERO_ADDRESS,
    agniUsdyUsdc: ov.agniUsdyUsdc ?? MANTLE_AGNI_USDY_USDC,
    usdyBlocklist: ov.usdyBlocklist ?? MANTLE_USDY_BLOCKLIST,
  };

  for (const [name, addr] of [
    ['usdy', addresses.usdy],
    ['agniUsdyUsdc', addresses.agniUsdyUsdc],
    ['usdyBlocklist', addresses.usdyBlocklist],
  ] as const) {
    if (addr === ZERO_ADDRESS) {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/ondo-usdy] address '${name}' is the zero address. Pass addresses: { ${name} } for custom deployments.`,
      );
    }
  }

  const ctx: ActionContext = { publicClient, chainId, addresses };

  return Object.freeze({
    chainId: SUPPORTED_CHAIN_ID,
    actions: Object.freeze({
      getBalance: createGetBalanceTool(ctx),
      getRateAccrual: createGetRateAccrualTool(ctx),
      getYieldRate: createGetYieldRateTool(ctx),
    }),
    selectors: Object.freeze({
      isUserEligible: (user: `0x${string}`) =>
        isUserEligible(publicClient, addresses.usdyBlocklist, user),
    }),
  });
}
