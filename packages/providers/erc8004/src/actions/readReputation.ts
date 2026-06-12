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
    .describe('Total feedback entries across all clients'),
  latestAttestation: LatestAttestationSchema.nullable().describe(
    'Most recent attestation, or null if no attestations exist',
  ),
  schemaCounts: z
    .record(z.string(), z.number().int().positive())
    .describe('Counts per schema name (tag2)'),
});

export async function executeReadReputation(
  ctx: ActionContext,
  input: z.infer<typeof ReadReputationInput>,
): Promise<z.infer<typeof ReadReputationOutput>> {
  const clients = await ctx.publicClient.readContract({
    address: ctx.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'getClients',
    args: [input.agentId],
  });

  if (clients.length === 0) {
    return { totalAttestations: 0, latestAttestation: null, schemaCounts: {} };
  }

  // readAllFeedback returns (clients[], feedbackIndexes[], values[], valueDecimals[], tag1s[], tag2s[], revokedStatuses[])
  const feedback = await ctx.publicClient.readContract({
    address: ctx.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'readAllFeedback',
    args: [input.agentId, clients, '', '', false],
  });

  const feedbackIndexes = feedback[1];
  const values = feedback[2];
  const tag2s = feedback[5];

  const totalAttestations = feedbackIndexes.length;

  if (totalAttestations === 0) {
    return { totalAttestations: 0, latestAttestation: null, schemaCounts: {} };
  }

  const schemaCounts: Record<string, number> = {};
  for (const tag2 of tag2s) {
    schemaCounts[tag2] = (schemaCounts[tag2] ?? 0) + 1;
  }

  const lastIdx = totalAttestations - 1;
  const latestFeedbackIndex = feedbackIndexes[lastIdx];
  const latestValue = values[lastIdx];
  const latestSchema = tag2s[lastIdx];

  const latestAttestation =
    latestFeedbackIndex !== undefined && latestValue !== undefined && latestSchema !== undefined
      ? {
          schema: latestSchema,
          feedbackIndex: latestFeedbackIndex,
          value: latestValue,
        }
      : null;

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
