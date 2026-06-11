import type { Address } from '@concierge/shared';
import { z } from 'zod';

export const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

export const NON_ZERO_ADDRESS = HEX_ADDRESS.refine(
  (addr) => addr !== '0x0000000000000000000000000000000000000000',
  { message: 'address must not be the zero address' },
) as z.ZodType<Address>;

export const NON_NEG_INT_STR = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer decimal string');

export const POSITIVE_BIGINT_STR = z.coerce
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer string');

export const VENUE_NAME = z.enum(['merchantMoe', 'agni', 'fusionx', 'woofi', 'lifi']);
