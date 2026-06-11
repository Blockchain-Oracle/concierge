// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ─── Mantle Mainnet (chainId 5000) ────────────────────────────────────────────
// All addresses verified via research/concierge/AUDIT-2026-06-04.md and
// research/concierge/03-providers/*.md on 2026-06-04 / 2026-06-09.

// Aave V3 on Mantle Mainnet
address constant AAVE_V3_POOL_MAINNET = 0x458F293454fE0d67EC0655f3672301301DD51422;
address constant AAVE_V3_ORACLE_MAINNET = 0x47a063CfDa980532267970d478EC340C0F80E8df;
address constant AAVE_V3_ADDRESSES_PROVIDER_MAINNET = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
address constant AAVE_V3_PROTOCOL_DATA_PROVIDER_MAINNET =
    0x487c5c669D9eee6057C44973207101276cf73b68;

// Token addresses on Mantle Mainnet
address constant SUSDE_MAINNET = 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2;
address constant USDC_MAINNET = 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9;
address constant USDE_MAINNET = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
address constant USDY_MAINNET = 0x5bE26527e817998A7206475496fDE1E68957c5A6;
address constant METH_MAINNET = 0xcDA86A272531e8640cD7F1a92c01839911B90bb0;
address constant WMNT_MAINNET = 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8;

// ERC-8004 on Mantle Mainnet (verified 2026-06-04)
address constant ERC8004_IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
address constant ERC8004_REPUTATION_MAINNET = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

// Li.Fi Diamond (cross-chain, same address all networks)
address constant LIFI_DIAMOND = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;

// ─── Mantle Sepolia (chainId 5003) — ERC-8004 only ────────────────────────────
// Mock tokens + Aave are deployed fresh by HelperConfig. ERC-8004 already lives
// on the real Sepolia testnet deployment.

address constant ERC8004_IDENTITY_SEPOLIA = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
address constant ERC8004_REPUTATION_SEPOLIA = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

// ─── E-Mode constants ─────────────────────────────────────────────────────────

uint8 constant EMODE_STABLECOIN_CATEGORY = 1; // sUSDe E-Mode 1 on Mantle Mainnet
