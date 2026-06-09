// Identity helper — preserves generic narrowing so `invoke` arg type infers from inputSchema.

import type { z } from 'zod';
import type { ConciergeTool } from './types.ts';

export function tool<
  TIn extends z.ZodTypeAny,
  // biome-ignore lint/suspicious/noExplicitAny: matches the ConciergeTool ZodObject<any> generic
  TOut extends z.ZodObject<any>,
>(def: ConciergeTool<TIn, TOut>): ConciergeTool<TIn, TOut> {
  return def;
}
