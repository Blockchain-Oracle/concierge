// Canonical on-chain addresses for Concierge across both Mantle networks.
// FROZEN — verified via on-chain `cast call` 2026-06-03 (see research/concierge/AUDIT-2026-06-04.md).
// Do NOT modify without re-running the verification pass against `https://rpc.mantle.xyz`.
//
// Sepolia (5003) values for non-ERC-8004 contracts are 0x000…000 placeholders;
// story-192 fills them in after the Sepolia mock-deploy lands. The ERC-8004
// Sepolia values ARE real (Mantle has a testnet deployment for ERC-8004).
//
// Source of truth per contract:
//   aave.*           → research/concierge/03-providers/aave-v3-mantle.md
//   tokens.*         → same doc (Aave reserves) + research/concierge/03-providers/{ethena-susde,ondo-usdy,meth-staking}.md
//   erc8004.*        → research/concierge/03-providers/erc8004.md
//   lifi.diamond     → research/concierge/03-providers/lifi-bridge.md
//   mantleDex.*      → research/concierge/03-providers/mantle-dex.md

import { assertNumericChainId } from './chains.ts';
import type { Address, EvmChainId } from './types.ts';

/**
 * Canonical zero-address placeholder. Exported so downstream guards (e.g. the
 * SDK's `requireAddress`) compare against THIS string instead of re-typing
 * their own copy — a one-character drift would silently disable every
 * zero-address check downstream.
 */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// Recursive Object.freeze so downstream packages cannot mutate the registry at runtime.
// `as const` only narrows the type — without runtime freezing, a single
// `(ADDRESSES.mantleMainnet.aave as any).pool = '0xdead…'` would silently re-route every
// subsequent Aave call. The registry is meant to be immutable; enforce it.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export const ADDRESSES = deepFreeze({
  mantleMainnet: {
    aave: {
      pool: '0x458F293454fE0d67EC0655f3672301301DD51422' as Address,
      oracle: '0x47a063CfDa980532267970d478EC340C0F80E8df' as Address,
      addressesProvider: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f' as Address,
      protocolDataProvider: '0x487c5c669D9eee6057C44973207101276cf73b68' as Address,
    },
    tokens: {
      USDC: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' as Address,
      USDe: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' as Address,
      sUSDe: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2' as Address,
      WMNT: '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8' as Address,
      // Canonical Mantle WETH vanity address per research/concierge/03-providers/aave-v3-mantle.md:34.
      // It IS a real reserve in the Aave Mantle market — the `dead1111` pattern is intentional
      // (deployed via CREATE2 to match Mantle's WETH9 vanity convention). Do not flag as placeholder.
      WETH: '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111' as Address,
      USDY: '0x5bE26527e817998A7206475496fDE1E68957c5A6' as Address,
      mETH: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0' as Address,
    },
    erc8004: {
      identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as Address,
      reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as Address,
    },
    lifi: {
      diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address,
    },
    mantleDex: {
      merchantMoe: {
        lbRouter: '0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a' as Address,
        lbQuoter: '0x501b8AFd35df20f531fF45F6f695793AC3316c85' as Address,
      },
      agni: {
        factory: '0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035' as Address,
        swapRouter: '0x319B69888b0d11cEC22caA5034e25FfFBDc88421' as Address,
        quoterV2: '0xc4aaDc921E1cdb66c5300Bc158a313292923C0cb' as Address,
      },
      fusionx: {
        swapRouter: '0x5989FB161568b9F133eDf5Cf6787f5597762797F' as Address,
        factory: '0x530d2766D1988CC1c000C8b7d00334c14B69AD71' as Address,
        quoterV2: '0x90f72244294E7c5028aFd6a96E18CC2c1E913995' as Address,
      },
      woofi: {
        router: '0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7' as Address,
        pool: '0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4' as Address,
      },
    },
    // Filled in by story-19 (deploy-mainnet.sh + write-addresses.mjs --network mainnet)
    conciergeRegistry: ZERO_ADDRESS,
  },
  mantleSepolia: {
    aave: {
      // Aave V3 has NO Sepolia deployment per research/concierge/03-providers/aave-v3-mantle.md.
      // Concierge mocks Aave on Sepolia via story-14 (MockAavePool) + story-16 (MockAaveOracle).
      // Addresses below are filled in by story-192 (Sepolia playground deploy).
      pool: ZERO_ADDRESS,
      oracle: ZERO_ADDRESS,
      addressesProvider: ZERO_ADDRESS,
      protocolDataProvider: ZERO_ADDRESS,
    },
    tokens: {
      // Mock token addresses land in story-15 (MockERC20s for sUSDe/USDC/USDY/mETH).
      USDC: ZERO_ADDRESS,
      USDe: ZERO_ADDRESS,
      sUSDe: ZERO_ADDRESS,
      WMNT: ZERO_ADDRESS,
      WETH: ZERO_ADDRESS,
      USDY: ZERO_ADDRESS,
      mETH: ZERO_ADDRESS,
    },
    erc8004: {
      // Real Mantle Sepolia ERC-8004 deployment per research/concierge/03-providers/erc8004.md:14.
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address,
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address,
    },
    lifi: {
      diamond: ZERO_ADDRESS,
    },
    mantleDex: {
      merchantMoe: {
        lbRouter: ZERO_ADDRESS,
        lbQuoter: ZERO_ADDRESS,
      },
      agni: {
        factory: ZERO_ADDRESS,
        swapRouter: ZERO_ADDRESS,
        quoterV2: ZERO_ADDRESS,
      },
      fusionx: {
        swapRouter: ZERO_ADDRESS,
        factory: ZERO_ADDRESS,
        quoterV2: ZERO_ADDRESS,
      },
      woofi: {
        router: ZERO_ADDRESS,
        pool: ZERO_ADDRESS,
      },
    },
    // Filled in by story-18 (DeployAll.s.sol + write-addresses.mjs)
    conciergeRegistry: ZERO_ADDRESS,
  },
} as const);

/**
 * Resolve the addresses block for a given Mantle chain id.
 *
 * Returns the union of both block shapes — the generic-conditional pattern was
 * decorative (narrowing required an `as never` cast in the impl that could mask
 * a branch-swap typo). When chain-specific fields diverge across networks,
 * promote to overloads.
 *
 * Inputs are validated for type (string from env / bigint from JSON-parse fail
 * with a typed TypeError, not the generic "unsupported chain id" message).
 */
export function addressesFor(
  chainId: EvmChainId,
): typeof ADDRESSES.mantleMainnet | typeof ADDRESSES.mantleSepolia {
  assertNumericChainId(chainId, 'addressesFor');
  if (chainId === 5000) return ADDRESSES.mantleMainnet;
  if (chainId === 5003) return ADDRESSES.mantleSepolia;
  throw new Error(
    `[@concierge/shared] addressesFor: unsupported Mantle chain id ${chainId satisfies never} (expected 5000 mainnet or 5003 sepolia)`,
  );
}

/**
 * Recursive leaf-path type for `ADDRESSES.*` blocks. Each entry resolves to a
 * dot-separated path string whose terminal is an `Address`. Typing
 * `SEPOLIA_PENDING_ADDRESS_SLOTS` against this catches renames at compile time —
 * e.g., `tokens.USDC` → `tokens.usdc` would fail the build immediately instead
 * of silently passing the lockbox test until story-192 trips on a stale path.
 */
type LeafPath<T> = T extends Address
  ? '' // Base case: Address is a leaf — collapse to '' so the parent emits the key without a trailing dot.
  : T extends Record<string, unknown>
    ? {
        [K in keyof T & string]: LeafPath<T[K]> extends '' ? K : `${K}.${LeafPath<T[K]>}`;
      }[keyof T & string]
    : never;

/** Valid dot-paths on `ADDRESSES.mantleMainnet` (compile-time enforced). */
export type MainnetAddressPath = LeafPath<typeof ADDRESSES.mantleMainnet>;

/** Valid dot-paths on `ADDRESSES.mantleSepolia` (compile-time enforced). */
export type SepoliaAddressPath = LeafPath<typeof ADDRESSES.mantleSepolia>;

/**
 * Dot-paths valid on BOTH chains — the intersection self-maintains: when a
 * chain-specific slot exists on only one network, it is absent from the other
 * chain's LeafPath and therefore absent from this intersection. Cross-chain
 * lookups then fail at compile time instead of at runtime.
 */
export type AddressPath = LeafPath<typeof ADDRESSES.mantleMainnet> & SepoliaAddressPath;

/**
 * Slot paths on `ADDRESSES.mantleSepolia` that intentionally hold the zero address until
 * a later story populates them. Story-15 / story-192 will delete entries from this list
 * as it lands real mock-deploy addresses — turning a future regression (someone reverting
 * a populated address back to zero) into a test failure instead of a silent footgun.
 *
 * MUST stay lexically sorted (default JS Array.sort comparator) — the lockbox test
 * compares against `.sort()`. Asserted in index.test.ts.
 */
export const SEPOLIA_PENDING_ADDRESS_SLOTS = Object.freeze([
  'aave.addressesProvider',
  'aave.oracle',
  'aave.pool',
  'aave.protocolDataProvider',
  'conciergeRegistry',
  'lifi.diamond',
  'mantleDex.agni.factory',
  'mantleDex.agni.quoterV2',
  'mantleDex.agni.swapRouter',
  'mantleDex.fusionx.factory',
  'mantleDex.fusionx.quoterV2',
  'mantleDex.fusionx.swapRouter',
  'mantleDex.merchantMoe.lbQuoter',
  'mantleDex.merchantMoe.lbRouter',
  'mantleDex.woofi.pool',
  'mantleDex.woofi.router',
  'tokens.USDC',
  'tokens.USDY',
  'tokens.USDe',
  'tokens.WETH',
  'tokens.WMNT',
  'tokens.mETH',
  'tokens.sUSDe',
] as const satisfies readonly SepoliaAddressPath[]);

/**
 * Slot paths on `ADDRESSES.mantleMainnet` that hold zero-address placeholders until
 * the Mainnet production deploy (story-19 `deploy-mainnet.sh`) runs. Mirrors the
 * Sepolia lockbox pattern — deleted entries signal that `write-addresses.mjs
 * --network mainnet` has populated the real deployed address.
 *
 * MUST stay lexically sorted (default JS Array.sort comparator) — the lockbox
 * test compares against `.sort()`. Asserted in addresses.test.ts.
 */
export const MAINNET_PENDING_ADDRESS_SLOTS = Object.freeze([
  'conciergeRegistry',
] as const satisfies readonly MainnetAddressPath[]);
