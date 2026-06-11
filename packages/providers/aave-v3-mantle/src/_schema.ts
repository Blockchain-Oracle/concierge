// Shared Zod primitives for action input schemas.
// Centralised here to avoid the unsafe `as z.ZodType<Address>` cast being duplicated per file.

import type { Address } from '@concierge/shared';
import { z } from 'zod';

export const HEX_ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/) as z.ZodType<Address>;

export const NON_ZERO_ADDRESS = HEX_ADDRESS.refine(
  (addr) => addr !== '0x0000000000000000000000000000000000000000',
  { message: 'address must not be the zero address' },
) as z.ZodType<Address>;

// Accepts string, number, or bigint — compatible with MCP JSON transport (no native bigint in JSON).
export const POSITIVE_BIGINT = z.coerce
  .bigint()
  .refine((v) => v > 0n, { message: 'must be a positive integer' });
