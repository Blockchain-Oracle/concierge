// @concierge/sdk — META package (story-22 amended, ADR-014/016/018/019):
// one install + one import for the Concierge core. Curated named re-exports
// (not `export *`) so the public surface is deliberate.
//
// The agent-runtime exports (`createConcierge`, `Concierge`) land when
// `@concierge/agent` is born in Epic E5 — no story before E5 creates that
// package, and stubbing a fake runtime here is a banned hot-path mock. See
// the deferral addendum in docs/stories/story-22-sdk-skeleton.md.

// SEPOLIA_PENDING_ADDRESS_SLOTS is the programmatic guard for
// `ConciergeRegistry.sepolia()`'s zero-address placeholders (pending
// story-192's mock deploys) — SDK-only consumers must be able to detect a
// pending slot without reading the README.
export {
  type AddressPath,
  SEPOLIA_PENDING_ADDRESS_SLOTS,
  type SepoliaAddressPath,
} from '@concierge/shared';
export {
  bigintSafeStringify,
  CARD_SCHEMAS,
  type ConciergeAgentLike,
  type ConciergeTool,
  createConciergeTools,
  type JsonSerializable,
  type ProviderToolFactory,
  type SerializablePortfolioCard,
  SerializablePortfolioCardSchema,
  type SerializableProposalCard,
  SerializableProposalCardSchema,
  type SerializableReputationCard,
  SerializableReputationCardSchema,
  type SerializableTickCard,
  SerializableTickCardSchema,
  safeParseSerializablePortfolioCard,
  safeParseSerializableProposalCard,
  safeParseSerializableReputationCard,
  safeParseSerializableTickCard,
  TICK_PHASE_VALUES,
  type TickPhase,
  tool,
  type UICardId,
} from '@concierge/tools';
export { getVercelAITools, toVercelAITool } from '@concierge/vercel-ai';
export { defaultModel } from './defaultModel.ts';
export {
  CONCIERGE_ERROR_TYPES,
  ConciergeError,
  type ConciergeErrorType,
  ConfigError,
  isConciergeErrorType,
} from './errors.ts';
export { ConciergeRegistry } from './registry.ts';
