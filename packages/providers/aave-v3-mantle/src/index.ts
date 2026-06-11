// @concierge/aave-v3-mantle — Aave V3 Mantle action provider.
// 6 actions: supply, borrow, repay, withdraw, setUserEMode, claimRewards.
// Verified on-chain addresses in research/concierge/03-providers/aave-v3-mantle.md.

export { assertHFAboveFloor } from './actions/withdraw.ts';
export type { AaveAction, AttestationContext, AttestationPayload } from './attestation.ts';
export {
  AAVE_ATTESTATION_SCHEMAS,
  AttestationPayloadSchema,
  buildAttestationPayload,
} from './attestation.ts';
export {
  type AaveV3MantleAddressOverrides,
  type AaveV3MantleProvider,
  type AaveV3MantleProviderOpts,
  createAaveV3MantleProvider,
} from './provider.ts';
export {
  getReserveData,
  getUserAccountData,
  getUserEMode,
  type MaxSafeBorrowOpts,
  maxSafeBorrow,
  type ReserveData,
  type UserAccountData,
} from './selectors.ts';
