// Canonical on-chain addresses for Concierge across both Mantle networks.
// FROZEN — verified via on-chain `cast call` 2026-06-03 (see research/concierge/AUDIT-2026-06-04.md).
// Do NOT modify without re-running the verification pass against `https://rpc.mantle.xyz`.
//
// Sepolia (5003) values for non-ERC-8004 contracts are 0x000…000 placeholders;
// story-190 fills them in after the Sepolia mock-deploy lands. The ERC-8004
// Sepolia values ARE real (Mantle has a testnet deployment for ERC-8004).
//
// Source of truth per contract:
//   aave.*           → research/concierge/03-providers/aave-v3-mantle.md
//   tokens.*         → same doc (Aave reserves) + research/concierge/03-providers/{ethena-susde,ondo-usdy,meth-staking}.md
//   erc8004.*        → research/concierge/03-providers/erc8004.md
//   lifi.diamond     → research/concierge/03-providers/lifi-bridge.md
//   mantleDex.*      → research/concierge/03-providers/mantle-dex.md

import type { Address, EvmChainId } from './types.ts';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export const ADDRESSES = {
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
        // Liquidity Book v2.2 — the surface Concierge swaps through (concentrated-liquidity bins).
        lbRouter: '0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a' as Address,
      },
      agni: {
        // Uniswap v3 fork; Factory is the primary entry for pool discovery.
        factory: '0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035' as Address,
      },
    },
  },
  mantleSepolia: {
    aave: {
      // Aave V3 has NO Sepolia deployment per research/concierge/03-providers/aave-v3-mantle.md.
      // Concierge mocks Aave on Sepolia via story-14 (MockAavePool) + story-16 (MockAaveOracle).
      // Addresses below are filled in by story-192 (Sepolia playground deploy).
      pool: ZERO,
      oracle: ZERO,
      addressesProvider: ZERO,
      protocolDataProvider: ZERO,
    },
    tokens: {
      // Mock token addresses land in story-15 (MockERC20s for sUSDe/USDC/USDY/mETH).
      USDC: ZERO,
      USDe: ZERO,
      sUSDe: ZERO,
      WMNT: ZERO,
      WETH: ZERO,
      USDY: ZERO,
      mETH: ZERO,
    },
    erc8004: {
      // Real Mantle Sepolia ERC-8004 deployment — verified live.
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as Address,
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as Address,
    },
    lifi: {
      diamond: ZERO,
    },
    mantleDex: {
      merchantMoe: {
        lbRouter: ZERO,
      },
      agni: {
        factory: ZERO,
      },
    },
  },
} as const;

/** Helper: resolve the addresses block for a given Mantle chain id. */
export function addressesFor(chainId: EvmChainId): (typeof ADDRESSES)[keyof typeof ADDRESSES] {
  if (chainId === 5000) return ADDRESSES.mantleMainnet;
  if (chainId === 5003) return ADDRESSES.mantleSepolia;
  // EvmChainId narrows to 5000 | 5003 at compile time; this is defense-in-depth.
  throw new Error(`Unsupported chain id: ${chainId}`);
}
