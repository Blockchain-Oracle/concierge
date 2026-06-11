import { z } from 'zod';

export const NON_ZERO_ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a hex address')
  .refine((v) => v !== '0x0000000000000000000000000000000000000000', 'must be non-zero address');

export const NON_NEG_INT_STR = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer decimal string');

export const TX_HASH = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex transaction hash');
