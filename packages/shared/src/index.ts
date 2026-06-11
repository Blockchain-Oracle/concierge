// Barrel exports for @concierge/shared.

export {
  ADDRESSES,
  type AddressPath,
  addressesFor,
  MAINNET_PENDING_ADDRESS_SLOTS,
  type MainnetAddressPath,
  SEPOLIA_PENDING_ADDRESS_SLOTS,
  type SepoliaAddressPath,
  ZERO_ADDRESS,
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
