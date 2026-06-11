// ERC-8004 attestation payload builder for Aave V3 Mantle actions.
// Returns the raw JSON payload; EIP-712 hash + on-chain write belong to story-67 (record phase).

import type { Address, Hex } from '@concierge/shared';
import { z } from 'zod';

export type AaveAction =
  | 'supply'
  | 'borrow'
  | 'repay'
  | 'withdraw'
  | 'setUserEMode'
  | 'claimRewards';

// Canonical schema names — literal strings enable grep-based audits.
export const AAVE_ATTESTATION_SCHEMAS = {
  supply: 'concierge.aave.v3.supply.v1',
  borrow: 'concierge.aave.v3.borrow.v1',
  repay: 'concierge.aave.v3.repay.v1',
  withdraw: 'concierge.aave.v3.withdraw.v1',
  setUserEMode: 'concierge.aave.v3.setUserEMode.v1',
  claimRewards: 'concierge.aave.v3.claimRewards.v1',
} as const satisfies Record<AaveAction, string>;

export const AttestationPayloadSchema = z.object({
  schema: z
    .string()
    .describe(
      'concierge.aave.v3.<action>.v1 — used by the record phase to select the ERC-8004 schema',
    ),
  chain: z.number(),
  pool: z.string(),
  asset: z.string(),
  amountBase: z
    .string()
    .describe('Amount in token base units (bigint serialised to decimal string)'),
  txHash: z.string(),
  preHF: z.string().describe('Health factor before the action (1e18 scaled, decimal string)'),
  postHF: z.string().describe('Health factor after the action (1e18 scaled, decimal string)'),
  eMode: z
    .number()
    .describe('Active E-Mode category at execution time (0=general, 1=sUSDe, 2=USDe)'),
  ts: z.number().describe('Unix timestamp (seconds) of payload construction'),
});

export type AttestationPayload = z.infer<typeof AttestationPayloadSchema>;

export interface AttestationContext {
  action: AaveAction;
  chainId: number;
  pool: Address;
  asset: Address;
  amountBase: bigint;
  txHash: Hex;
  preHF: bigint;
  postHF: bigint;
  eMode: number;
}

export function buildAttestationPayload(ctx: AttestationContext): AttestationPayload {
  return {
    schema: AAVE_ATTESTATION_SCHEMAS[ctx.action],
    chain: ctx.chainId,
    pool: ctx.pool,
    asset: ctx.asset,
    amountBase: ctx.amountBase.toString(),
    txHash: ctx.txHash,
    preHF: ctx.preHF.toString(),
    postHF: ctx.postHF.toString(),
    eMode: ctx.eMode,
    ts: Math.floor(Date.now() / 1000),
  };
}
