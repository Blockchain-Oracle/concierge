// Shared primitive types used across @concierge/* packages.
// viem re-exports — keep a single import surface for downstream code.

export type { Address, Hex } from 'viem';

/** Concierge supports two Mantle networks today. */
export type EvmChainId = 5000 | 5003;

/** Stable identifier for an autonomous agent instance. */
export type AgentId = string & { readonly __brand: 'AgentId' };

/** Tick-loop phases per ADR-002. The agent's loop walks plan → simulate → propose → execute → record. */
export type TickPhase = 'plan' | 'simulate' | 'propose' | 'execute' | 'record';

/** High-level action categories the agent can take. Provider-package-specific actions narrow further. */
export type ActionKind =
  | 'supply'
  | 'borrow'
  | 'repay'
  | 'withdraw'
  | 'swap'
  | 'bridge'
  | 'stake'
  | 'unstake'
  | 'wrap'
  | 'unwrap'
  | 'attest';

/** Provider package name, used for routing and tool registry lookups. Mirrors packages/providers/* directory names. */
export type ProviderName =
  | 'aave-v3-mantle'
  | 'mantle-dex'
  | 'ethena-susde'
  | 'ondo-usdy'
  | 'meth-staking'
  | 'lifi-bridge'
  | 'erc8004';
