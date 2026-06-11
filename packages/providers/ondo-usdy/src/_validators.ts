import { z } from 'zod';

export const NON_NEG_INT_STR = z.string().regex(/^\d+$/, 'must be a non-negative integer string');

export const POSITIVE_INT_STR = NON_NEG_INT_STR.refine((v) => v !== '0', {
  message: 'must be a positive integer string (non-zero)',
});

export const NON_ZERO_ADDRESS = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((v) => v !== '0x0000000000000000000000000000000000000000', 'must not be zero address');
