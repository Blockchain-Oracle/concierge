import { z } from 'zod';
import { ADDR, ADDR_REGEX, NON_NEG_INT_STR } from './_zod.ts';

export const LifiGasCostSchema = z.object({
  amount: z.string(),
  amountUSD: z.string().optional(),
  token: z.object({ address: z.string(), symbol: z.string(), decimals: z.number() }),
});

export const LifiTransactionRequestSchema = z.object({
  // Typed as 0x${string} so callers (sendTransaction) don't need unsafe casts
  to: z
    .string()
    .regex(ADDR_REGEX)
    .transform((v) => v as `0x${string}`),
  data: z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/)
    .transform((v) => v as `0x${string}`),
  value: z.string(),
  gasLimit: z.string().optional(),
  gasPrice: z.string().optional(),
  chainId: z.number(),
});

// Amount fields are digit-only strings — guards against decimal/scientific notation
// that would silently produce wrong on-chain attestation values
export const LifiStepEstimateSchema = z.object({
  fromAmount: NON_NEG_INT_STR,
  toAmount: NON_NEG_INT_STR,
  toAmountMin: NON_NEG_INT_STR,
  executionDuration: z.number(),
  gasCosts: z.array(LifiGasCostSchema).optional(),
});

export const LifiTokenSchema = z.object({
  address: ADDR, // format-only (no non-zero) — native gas tokens use 0x0... in some bridges
  symbol: z.string(),
  decimals: z.number(),
  name: z.string().optional(),
  chainId: z.number().optional(),
});

// The action field on a Li.Fi Step — carries fromToken/toToken/chain info
const LifiActionSchema = z.object({
  fromChainId: z.number(),
  toChainId: z.number(),
  fromToken: LifiTokenSchema,
  toToken: LifiTokenSchema,
  fromAmount: z.string(),
  fromAddress: z.string(),
  toAddress: z.string().optional(),
  slippage: z.number(),
});

// Response schema for GET /v1/quote — a single Step object with transactionRequest inline
export const LifiQuoteResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  tool: z.string(),
  toolDetails: z.object({
    name: z.string(),
    key: z.string(),
    logoURI: z.string().optional(),
  }),
  action: LifiActionSchema,
  estimate: LifiStepEstimateSchema,
  transactionRequest: LifiTransactionRequestSchema,
  includedSteps: z.array(z.unknown()).optional(),
});

// Internal enriched route — fromToken/toToken promoted from action, _receivedAt added
export const LifiBridgeRouteSchema = z.object({
  id: z.string(),
  tool: z.string(),
  toolDetails: z.object({ name: z.string(), key: z.string(), logoURI: z.string().optional() }),
  fromChainId: z.number(),
  toChainId: z.number(),
  fromToken: LifiTokenSchema,
  toToken: LifiTokenSchema,
  estimate: LifiStepEstimateSchema,
  transactionRequest: LifiTransactionRequestSchema,
  _receivedAt: z.number(),
});

export type LifiBridgeRoute = z.infer<typeof LifiBridgeRouteSchema>;
export type LifiTransactionRequest = z.infer<typeof LifiTransactionRequestSchema>;

export const LifiStatusResponseSchema = z.object({
  status: z.enum(['PENDING', 'DONE', 'FAILED', 'NOT_FOUND']),
  fromTx: z.object({ txHash: z.string(), chainId: z.number().optional() }).optional(),
  toTx: z.object({ txHash: z.string(), chainId: z.number().optional() }).optional(),
  tool: z.string().optional(),
  bridgeExplorer: z.string().optional(),
  metadata: z.object({ bridges: z.array(z.object({ name: z.string() })).optional() }).optional(),
});

export type LifiStatusResponse = z.infer<typeof LifiStatusResponseSchema>;
