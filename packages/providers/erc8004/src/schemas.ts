import { keccak256, toBytes } from 'viem';

// Schema IDs are keccak256(schemaName) — computed at module load for determinism.
// Pre-registering prevents silent typos at call sites: a misspelled schema name would
// generate a different hash that would never match any stored attestation.

function makeSchemaId(name: string): `0x${string}` {
  return keccak256(toBytes(name));
}

// All Concierge provider schemas. Each provider registers its own set.
// Name convention: concierge.<provider>.<action>.v<N>
const SCHEMA_NAMES = [
  // Aave V3
  'concierge.aave.v3.supply.v1',
  'concierge.aave.v3.borrow.v1',
  'concierge.aave.v3.repay.v1',
  'concierge.aave.v3.withdraw.v1',
  'concierge.aave.v3.setUserEMode.v1',
  'concierge.aave.v3.claimRewards.v1',
  // Ethena sUSDe
  'concierge.ethena.wrap.v1',
  'concierge.ethena.unwrap.v1',
  // Ondo USDY
  'concierge.ondo.wrap.v1',
  'concierge.ondo.unwrap.v1',
  // mETH staking
  'concierge.meth.stake.v1',
  'concierge.meth.unstake.v1',
  'concierge.meth.unwrapToWETH.v1',
  // Li.Fi bridge
  'concierge.lifi.bridge.sent.v1',
  'concierge.lifi.bridge.completed.v1',
  // Mantle DEX swaps
  'concierge.mantle-dex.merchantMoe.swap.v1',
  'concierge.mantle-dex.agni.swap.v1',
  'concierge.mantle-dex.fusionx.swap.v1',
  'concierge.mantle-dex.woofi.swap.v1',
] as const;

export type KnownSchemaName = (typeof SCHEMA_NAMES)[number];

// Lookup table: schema name → keccak256 ID. Built at module load.
const SCHEMA_IDS: Record<string, `0x${string}`> = Object.fromEntries(
  SCHEMA_NAMES.map((name) => [name, makeSchemaId(name)]),
);

/**
 * Returns the keccak256 schema ID for a given schema name.
 * Accepts any string — not restricted to KnownSchemaName — so providers can
 * register custom schemas without patching this file.
 */
export function schemaIdFor(name: string): `0x${string}` {
  return SCHEMA_IDS[name] ?? makeSchemaId(name);
}

export { SCHEMA_NAMES };
