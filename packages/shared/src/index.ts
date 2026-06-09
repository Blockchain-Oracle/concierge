// Barrel exports for @concierge/shared.

export { ADDRESSES, addressesFor, SEPOLIA_PENDING_ADDRESS_SLOTS } from './addresses.ts';
export { chainFor, mantleMainnet, mantleSepolia } from './chains.ts';
export type {
  ActionKind,
  Address,
  AgentId,
  EvmChainId,
  Hex,
  ProviderName,
  TickPhase,
} from './types.ts';
export { agentId, isAgentId } from './types.ts';
