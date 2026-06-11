import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import type { YieldRateResult } from '../_types.ts';

const ETHENA_YIELDS_URL = 'https://api.ethena.fi/yields/protocol-and-staking-yield';

export const GetYieldRateInput = z.object({});

export const GetYieldRateOutput = z.object({
  protocolYieldBps: z.number().describe('Funding-rate component (bps)'),
  stakingYieldBps: z.number().describe('Combined protocol + staking yield (bps)'),
  susdeYieldBps: z.number().describe('Yield used for carry calculations (bps)'),
});

// Zod schema for Ethena API — validates both nested { data: {...} } and flat shapes.
const EthenaApiSchema = z.object({
  data: z
    .object({
      protocol: z.number().optional(),
      staking: z.number().optional(),
      protocol_yield: z.number().optional(),
      staking_yield: z.number().optional(),
    })
    .optional(),
  protocol: z.number().optional(),
  staking: z.number().optional(),
  protocol_yield: z.number().optional(),
  staking_yield: z.number().optional(),
});

function extractBps(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  // API returns percentage (e.g. 3.8 = 3.8%) — convert to bps (× 100).
  return Math.round(raw * 100);
}

export async function executeGetYieldRate(_ctx: ActionContext): Promise<YieldRateResult> {
  let rawJson: unknown;
  try {
    const res = await fetch(ETHENA_YIELDS_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/ethena-susde] getYieldRate: Ethena API returned ${res.status}`,
      );
    }
    rawJson = await res.json();
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    throw new ConciergeError(
      'RpcError',
      '[@concierge/ethena-susde] getYieldRate: failed to fetch Ethena yields API',
      err instanceof Error ? err : undefined,
    );
  }

  const parsed = EthenaApiSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new ConciergeError(
      'RpcError',
      '[@concierge/ethena-susde] getYieldRate: malformed Ethena API response',
      parsed.error,
      { zodIssues: parsed.error.issues },
    );
  }

  const inner = parsed.data.data ?? parsed.data;
  const protocolRaw = inner.protocol ?? inner.protocol_yield;
  const stakingRaw = inner.staking ?? inner.staking_yield;

  const protocolYieldBps = extractBps(protocolRaw);
  const stakingYieldBps = extractBps(stakingRaw ?? protocolRaw);

  if (protocolYieldBps < 0 || stakingYieldBps < 0) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/ethena-susde] getYieldRate: negative yield from Ethena API (protocolYieldBps=${protocolYieldBps}, stakingYieldBps=${stakingYieldBps})`,
    );
  }

  // Use the staking (combined) yield as the carry figure; fall back to protocol.
  const susdeYieldBps = stakingYieldBps > 0 ? stakingYieldBps : protocolYieldBps;

  if (susdeYieldBps === 0) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/ethena-susde] getYieldRate: extracted yield is zero (protocolYieldBps=${protocolYieldBps}, stakingYieldBps=${stakingYieldBps}) — Ethena API may be returning genuine zero or field names changed`,
    );
  }

  return { protocolYieldBps, stakingYieldBps, susdeYieldBps };
}

export function createGetYieldRateTool(ctx: ActionContext) {
  return tool({
    name: 'getYieldRate',
    description:
      'Fetches the current sUSDe annualised yield from the Ethena public API. ' +
      'Returns protocol and staking yields in basis points. Pure read — no transaction.',
    inputSchema: GetYieldRateInput,
    outputSchema: GetYieldRateOutput,
    supportsNetwork: (chainId) => chainId === ctx.chainId,
    invoke: () => executeGetYieldRate(ctx),
  });
}
