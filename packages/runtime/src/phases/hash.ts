import { z } from 'zod';

/** EVM-side 32-byte hex hash shape. Shared across execute + record phases. */
export const HASH_32_RE = /^0x[a-fA-F0-9]{64}$/;

/** Zod helper — `z.string().regex(HASH_32_RE)`. */
export const hash32Schema = z.string().regex(HASH_32_RE);

export function isHash32(s: string): boolean {
  return HASH_32_RE.test(s);
}
