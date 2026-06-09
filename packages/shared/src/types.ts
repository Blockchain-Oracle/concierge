// Shared primitive types used across @concierge/* packages.
//
// SOURCE OF TRUTH — downstream packages (story-60 llm, story-62 runtime,
// story-300 tools) MUST import from here. Never redeclare these locally;
// drift across redeclarations is a silent-failure footgun.
//
// viem types are re-exported so consumers have a single import surface.

export type { Address, Hex } from 'viem';

/** Concierge supports two Mantle networks today. */
export type EvmChainId = 5000 | 5003;

// `unique symbol` brand key — nominal at the type system level, so a structurally
// identical `{ __brand: 'AgentId' }` from another package cannot collide.
declare const AgentIdBrand: unique symbol;

/** Stable identifier for an autonomous agent instance. Construct via `agentId(raw)`. */
export type AgentId = string & { readonly [AgentIdBrand]: true };

// Format pinned by ERC-8004 minting flow (story-22) — `agent_` prefix + 32 lowercase
// hex chars derived from the agent NFT tokenId. Validated at construction so every
// downstream `AgentId` value has the same shape; no `as AgentId` casts elsewhere.
const AGENT_ID_RE = /^agent_[0-9a-f]{32}$/;

/** Construct an AgentId from a raw string. Throws if the input doesn't match the canonical format. */
export function agentId(raw: string): AgentId {
  if (!AGENT_ID_RE.test(raw)) {
    throw new Error(
      `[@concierge/shared] Invalid AgentId: ${JSON.stringify(raw)} (expected ${AGENT_ID_RE})`,
    );
  }
  return raw as AgentId;
}

/** Type guard for AgentId without throwing. */
export function isAgentId(raw: string): raw is AgentId {
  return AGENT_ID_RE.test(raw);
}

/**
 * Tick-loop phases per ADR-002 + architecture.md repo-structure. The autonomous
 * tick walks plan → simulate → propose → decide → execute → record. The `decide`
 * phase is where model routing escalates to Opus when the proposal is risk-flagged
 * (see story-60 routeModelForPhase).
 */
export type TickPhase = 'plan' | 'simulate' | 'propose' | 'decide' | 'execute' | 'record';

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
