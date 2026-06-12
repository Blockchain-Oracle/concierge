import { ConciergeError } from '@concierge/sdk';
import { reputationRegistryAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';

export const ReadFeedbackInput = z.object({
  agentId: z.bigint().describe('Agent NFT token ID'),
  fromBlock: z.bigint().optional().describe('Start block for event scan (defaults to genesis)'),
});

export const FeedbackEntrySchema = z.object({
  schema: z.string().describe('Provider schema (tag2 field from the NewFeedback event)'),
  feedbackHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('EIP-712 payload commitment stored on-chain'),
  feedbackIndex: z.bigint().describe('Feedback index in the ReputationRegistry'),
  clientAddress: z.string().describe('Address that submitted the feedback'),
  blockNumber: z.bigint().describe('Block number of the NewFeedback event'),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('Transaction hash'),
  revoked: z.boolean().describe('Whether this feedback entry has been subsequently revoked'),
});

export const ReadFeedbackOutput = z.object({
  entries: z.array(FeedbackEntrySchema).describe('All NewFeedback events for the agent'),
});

async function fetchRevokedIndexes(
  ctx: ActionContext,
  agentId: bigint,
  fromBlock: bigint,
): Promise<Set<bigint>> {
  const logs = await ctx.publicClient
    .getContractEvents({
      address: ctx.reputationRegistry,
      abi: reputationRegistryAbi,
      eventName: 'FeedbackRevoked',
      args: { agentId },
      fromBlock,
    })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] readFeedback: FeedbackRevoked fetch failed for agent ${agentId}`,
        err,
      );
    });
  return new Set(
    logs.flatMap((log) => (log.args.feedbackIndex !== undefined ? [log.args.feedbackIndex] : [])),
  );
}

export async function executeReadFeedback(
  ctx: ActionContext,
  input: z.infer<typeof ReadFeedbackInput>,
): Promise<z.infer<typeof ReadFeedbackOutput>> {
  const fromBlock = input.fromBlock ?? 0n;

  const logs = await ctx.publicClient
    .getContractEvents({
      address: ctx.reputationRegistry,
      abi: reputationRegistryAbi,
      eventName: 'NewFeedback',
      args: { agentId: input.agentId },
      fromBlock,
    })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] readFeedback: getContractEvents failed for agent ${input.agentId}`,
        err,
      );
    });

  const revokedIndexes = await fetchRevokedIndexes(ctx, input.agentId, fromBlock);

  const entries = logs.flatMap((log) => {
    const { args, blockNumber, transactionHash } = log;
    // blockNumber or transactionHash can be null for pending logs — skip those
    if (blockNumber === null || transactionHash === null) return [];
    if (
      args.feedbackIndex === undefined ||
      args.tag2 === undefined ||
      args.feedbackHash === undefined ||
      args.clientAddress === undefined
    ) {
      return [];
    }
    return [
      {
        schema: args.tag2,
        feedbackHash: args.feedbackHash,
        feedbackIndex: args.feedbackIndex,
        clientAddress: args.clientAddress,
        blockNumber,
        txHash: transactionHash,
        revoked: revokedIndexes.has(args.feedbackIndex),
      },
    ];
  });

  return { entries };
}

export function createReadFeedbackTool(ctx: ActionContext) {
  return tool({
    name: 'readFeedback',
    description:
      'Queries NewFeedback event logs from the ERC-8004 ReputationRegistry for a given agent. ' +
      'Returns all feedback entries with their EIP-712 payload commitments. ' +
      'The `revoked` field on each entry reflects FeedbackRevoked events in the same block range.',
    inputSchema: ReadFeedbackInput,
    outputSchema: ReadFeedbackOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeReadFeedback(ctx, input),
  });
}
