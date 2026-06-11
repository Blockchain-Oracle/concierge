import { z } from 'zod';

export const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;
export const ADDR_REGEX = /^0x[0-9a-fA-F]{40}$/;

// Address format only — no zero-address rejection (used for token addresses where
// 0x0000... can represent native gas tokens in some bridge protocols)
export const ADDR = z.string().regex(ADDR_REGEX);

// Non-zero address — for wallet/recipient/attestation addresses where zero means "unset"
export const NON_ZERO_ADDR = ADDR.refine((v) => v !== '0x0000000000000000000000000000000000000000');

export const NON_NEG_INT_STR = z.string().regex(/^\d+$/, 'must be a non-negative integer string');
export const TX_HASH = z.string().regex(TX_HASH_REGEX);
