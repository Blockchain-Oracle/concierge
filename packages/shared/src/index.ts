// Barrel exports for @concierge/shared.

export {
  ADDRESSES,
  addressesFor,
  SEPOLIA_PENDING_ADDRESS_SLOTS,
  type SepoliaAddressPath,
} from './addresses.ts';
export { assertNumericChainId, chainFor, mantleMainnet, mantleSepolia } from './chains.ts';
export type {
  ActionKind,
  Address,
  AgentId,
  EvmChainId,
  Hex,
  ModelRoutingPhase,
  ProviderName,
  TickLoopPhase,
} from './types.ts';
export {
  agentId,
  agentIdFromHex,
  agentIdFromJSON,
  agentIdToHex,
  agentIdToJSON,
  isAgentId,
} from './types.ts';
