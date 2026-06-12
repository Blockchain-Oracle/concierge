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
});

export const ReadFeedbackOutput = z.object({
  entries: z.array(FeedbackEntrySchema).describe('All NewFeedback events for the agent'),
});

export async function executeReadFeedback(
  ctx: ActionContext,
  input: z.infer<typeof ReadFeedbackInput>,
): Promise<z.infer<typeof ReadFeedbackOutput>> {
  const logs = await ctx.publicClient.getContractEvents({
    address: ctx.reputationRegistry,
    abi: reputationRegistryAbi,
    eventName: 'NewFeedback',
    args: { agentId: input.agentId },
    fromBlock: input.fromBlock ?? 0n,
  });

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
      'Returns all feedback entries with their EIP-712 payload commitments.',
    inputSchema: ReadFeedbackInput,
    outputSchema: ReadFeedbackOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeReadFeedback(ctx, input),
  });
}
