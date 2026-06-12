import { ConciergeError } from '@concierge/sdk';
import { reputationRegistryAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';

export const ReadReputationInput = z.object({
  agentId: z.bigint().describe('Agent NFT token ID'),
});

export const LatestAttestationSchema = z.object({
  schema: z.string().describe('Provider schema used for the most recent attestation (tag2)'),
  feedbackIndex: z.bigint().describe('Feedback index in the ReputationRegistry'),
  value: z.bigint().describe('Feedback value (signed int128 stored as bigint)'),
});

export const ReadReputationOutput = z.object({
  totalAttestations: z
    .number()
    .int()
    .nonnegative()
    .describe('Count of non-revoked feedback entries across all clients'),
  latestAttestation: LatestAttestationSchema.nullable().describe(
    'Most recent non-revoked attestation, or null if none exist',
  ),
  schemaCounts: z
    .record(z.string(), z.number().int().positive())
    .describe('Counts per schema name (tag2), revoked entries excluded'),
});

type FeedbackArrays = {
  feedbackIndexes: readonly bigint[];
  values: readonly bigint[];
  tag2s: readonly string[];
  revokedStatuses: readonly boolean[];
};

type FeedbackSummary = {
  schemaCounts: Record<string, number>;
  latestAttestation: z.infer<typeof LatestAttestationSchema> | null;
  totalAttestations: number;
};

async function fetchFeedbackArrays(
  ctx: ActionContext,
  agentId: bigint,
  clients: readonly `0x${string}`[],
): Promise<FeedbackArrays | null> {
  // readAllFeedback returns: (clients[], feedbackIndexes[], values[], valueDecimals[], tag1s[], tag2s[], revokedStatuses[])
  const feedback = await (async () => {
    try {
      return await ctx.publicClient.readContract({
        address: ctx.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: 'readAllFeedback',
        args: [agentId, clients, '', '', false],
      });
    } catch (err) {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] readReputation: readAllFeedback failed for agent ${agentId}`,
        err,
      );
    }
  })();

  const feedbackIndexes = feedback[1];
  const values = feedback[2];
  const tag2s = feedback[5];
  const revokedStatuses = feedback[6];

  if (feedbackIndexes.length === 0) return null;

  if (
    values.length !== feedbackIndexes.length ||
    tag2s.length !== feedbackIndexes.length ||
    revokedStatuses.length !== feedbackIndexes.length
  ) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/erc8004] readReputation: readAllFeedback returned inconsistent array lengths for agent ${agentId}`,
    );
  }

  return { feedbackIndexes, values, tag2s, revokedStatuses };
}

function summarizeFeedback(
  feedbackIndexes: readonly bigint[],
  values: readonly bigint[],
  tag2s: readonly string[],
  revokedStatuses: readonly boolean[],
): FeedbackSummary {
  const schemaCounts: Record<string, number> = {};
  let latestAttestation: z.infer<typeof LatestAttestationSchema> | null = null;
  for (let i = 0; i < feedbackIndexes.length; i++) {
    if (revokedStatuses[i] ?? false) continue;
    const feedbackIndex = feedbackIndexes[i];
    const value = values[i];
    const schema = tag2s[i];
    if (feedbackIndex === undefined || value === undefined || schema === undefined) {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] readReputation: malformed readAllFeedback response at index ${i}`,
      );
    }
    schemaCounts[schema] = (schemaCounts[schema] ?? 0) + 1;
    // feedbackIndex is monotonically assigned per agent — highest = most recent
    if (latestAttestation === null || feedbackIndex > latestAttestation.feedbackIndex) {
      latestAttestation = { schema, feedbackIndex, value };
    }
  }
  const totalAttestations = Object.values(schemaCounts).reduce((sum, n) => sum + n, 0);
  return { schemaCounts, latestAttestation, totalAttestations };
}

const EMPTY_RESULT = { totalAttestations: 0, latestAttestation: null, schemaCounts: {} } as const;

export async function executeReadReputation(
  ctx: ActionContext,
  input: z.infer<typeof ReadReputationInput>,
): Promise<z.infer<typeof ReadReputationOutput>> {
  const clients = await (async () => {
    try {
      return await ctx.publicClient.readContract({
        address: ctx.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: 'getClients',
        args: [input.agentId],
      });
    } catch (err) {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] readReputation: getClients failed for agent ${input.agentId}`,
        err,
      );
    }
  })();

  if (clients.length === 0) return EMPTY_RESULT;

  const arrays = await fetchFeedbackArrays(ctx, input.agentId, clients);
  if (arrays === null) return EMPTY_RESULT;

  const { feedbackIndexes, values, tag2s, revokedStatuses } = arrays;
  const { schemaCounts, latestAttestation, totalAttestations } = summarizeFeedback(
    feedbackIndexes,
    values,
    tag2s,
    revokedStatuses,
  );
  return { totalAttestations, latestAttestation, schemaCounts };
}

export function createReadReputationTool(ctx: ActionContext) {
  return tool({
    name: 'readReputation',
    description:
      'Reads all reputation feedback for an agent from the ERC-8004 ReputationRegistry. ' +
      'Returns total attestation count, most recent attestation details, and per-schema counts.',
    inputSchema: ReadReputationInput,
    outputSchema: ReadReputationOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeReadReputation(ctx, input),
  });
}
