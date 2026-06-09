// Shared primitive types used across @concierge/* packages.
//
// SOURCE OF TRUTH — downstream packages (story-22 SDK, story-42 ERC-8004 provider,
// story-60 llm, story-62 runtime, story-300 tools) MUST import from here. Never
// redeclare these locally; drift across redeclarations is a silent-failure footgun.
//
// viem types are re-exported so consumers have a single import surface.

export type { Address, Hex } from 'viem';

/** Concierge supports two Mantle networks today. */
export type EvmChainId = 5000 | 5003;

// `unique symbol` brand key — nominal at the type system level, so a structurally
// identical `{ __brand: 'AgentId' }` from another package cannot collide.
declare const AgentIdBrand: unique symbol;

/**
 * Stable identifier for an autonomous agent instance.
 *
 * IS the uint256 NFT tokenId returned by ERC-8004 `IdentityRegistry.register()`
 * per `research/concierge/03-providers/erc8004.md`. Carried as `bigint` to
 * round-trip uint256 without precision loss. Construct via `agentId(raw)`
 * or `agentIdFromHex(hex)`; never widen via `as AgentId` casts — the brand
 * is compile-time only and casts bypass range validation.
 */
export type AgentId = bigint & { readonly [AgentIdBrand]: true };

const UINT256_MAX = 2n ** 256n;

/**
 * Construct an AgentId from a raw bigint tokenId.
 * Throws if the value is negative or exceeds uint256 range.
 * Safe to echo `raw` in the error message — AgentId is a public identifier
 * (the ERC-8004 NFT tokenId, visible on every Mantle explorer).
 * Do NOT copy this constructor pattern for secret brands.
 */
export function agentId(raw: bigint): AgentId {
  if (typeof raw !== 'bigint') {
    throw new TypeError(
      `[@concierge/shared] agentId: raw must be bigint, got ${typeof raw} (${JSON.stringify(String(raw))})`,
    );
  }
  if (raw < 0n) {
    throw new RangeError(`[@concierge/shared] agentId: must be non-negative, got ${raw}`);
  }
  if (raw >= UINT256_MAX) {
    throw new RangeError(`[@concierge/shared] agentId: exceeds uint256 range, got ${raw}`);
  }
  return raw as AgentId;
}

/** Construct an AgentId from a 0x-prefixed hex string (e.g. an ERC-8004 receipt log). */
export function agentIdFromHex(hex: `0x${string}`): AgentId {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(
      `[@concierge/shared] agentIdFromHex: expected 0x-prefixed hex string, got ${typeof hex} (${JSON.stringify(String(hex))})`,
    );
  }
  try {
    return agentId(BigInt(hex));
  } catch (cause) {
    if (cause instanceof RangeError) throw cause;
    throw new TypeError(
      `[@concierge/shared] agentIdFromHex: failed to parse ${JSON.stringify(hex)} as bigint`,
      { cause },
    );
  }
}

/** Render an AgentId as a 0x-prefixed, 64-char-padded uint256 hex (canonical receipt form). */
export function agentIdToHex(id: AgentId): `0x${string}` {
  return `0x${id.toString(16).padStart(64, '0')}` as `0x${string}`;
}

/**
 * Render an AgentId as a JSON-safe decimal string. Use this at every boundary
 * that calls JSON.stringify (MCP structuredContent, Vercel AI SDK tool parts,
 * BullMQ job payloads, Next.js route handlers, Drizzle inserts). Raw bigint
 * cannot be JSON-serialized — JSON.stringify throws TypeError for bigint.
 */
export function agentIdToJSON(id: AgentId): string {
  return id.toString(10);
}

/** Parse an AgentId from a decimal-string JSON value (counterpart to agentIdToJSON). */
export function agentIdFromJSON(value: string): AgentId {
  return agentId(BigInt(value));
}

/** Type guard for AgentId without throwing. Accepts unknown input so JS↔TS boundaries can use it directly. */
export function isAgentId(raw: unknown): raw is AgentId {
  return typeof raw === 'bigint' && raw >= 0n && raw < UINT256_MAX;
}

/**
 * In-loop tick phases per ADR-002. The autonomous tick orchestrator walks
 * plan → simulate → propose → execute → record. Per story-62, the
 * `decide` step (user approval) happens OFF-LOOP between propose and execute
 * — it is NOT a phase the orchestrator executes. Use `ModelRoutingPhase`
 * for LLM model routing (story-60 routeModelForPhase).
 */
export type TickLoopPhase = 'plan' | 'simulate' | 'propose' | 'execute' | 'record';

/**
 * Model-routing keys per story-60 routeModelForPhase. Equals `TickLoopPhase`
 * plus `'decide'` for the off-loop user-approval branch (Opus escalation when
 * the proposal is risk-flagged).
 */
export type ModelRoutingPhase = TickLoopPhase | 'decide';

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
