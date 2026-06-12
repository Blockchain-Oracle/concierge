import { ConciergeError } from '@concierge/sdk';
import { reputationRegistryAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { decodeEventLog } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import { hashActionPayload } from '../eip712.ts';

export const AttestActionInput = z.object({
  agentId: z.bigint().describe('Agent NFT token ID from registerAgent'),
  providerSchema: z.string().min(1).describe('Schema name e.g. concierge.aave.v3.borrow.v1'),
  actionPayload: z
    .record(z.string(), z.unknown())
    .and(z.object({ schema: z.string() }))
    .describe('Full action payload — schema field must match providerSchema'),
});

export const AttestActionOutput = z.object({
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('Transaction hash'),
  feedbackIndex: z
    .bigint()
    .describe('Index of the stored feedback entry in the ReputationRegistry'),
  feedbackHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('EIP-712 hash committed on-chain as the tamper-evident payload commitment'),
});

export async function executeAttestAction(
  ctx: ActionContext,
  input: z.infer<typeof AttestActionInput>,
): Promise<z.infer<typeof AttestActionOutput>> {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/erc8004] attestAction: walletClient is required',
    );
  }

  const feedbackHash = hashActionPayload(input.actionPayload, input.agentId, ctx.chainId);

  try {
    // biome-ignore lint/suspicious/noExplicitAny: writeContract overloads vary by account/chain binding
    const txHash: `0x${string}` = await (ctx.walletClient as any).writeContract({
      address: ctx.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: 'giveFeedback',
      args: [
        input.agentId,
        1n, // value: 1 = successful action attestation
        0, // valueDecimals
        'concierge.action', // tag1: category
        input.providerSchema, // tag2: specific schema
        '', // endpoint
        '', // feedbackURI
        feedbackHash,
      ],
    });

    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: reputationRegistryAbi,
          eventName: 'NewFeedback',
          topics: log.topics,
          data: log.data,
        });
        return { txHash, feedbackIndex: decoded.args.feedbackIndex, feedbackHash };
      } catch {
        // Log from a different contract or event — skip
      }
    }

    throw new ConciergeError(
      'RpcError',
      `[@concierge/erc8004] attestAction: no NewFeedback event found in receipt ${txHash}`,
    );
  } catch (err) {
    if (err instanceof ConciergeError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const reason = /AgentNotFound/i.test(msg) ? 'AgentNotFound' : 'TxFailed';
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/erc8004] attestAction: giveFeedback reverted — ${msg}`,
      { reason, agentId: input.agentId },
    );
  }
}

export function createAttestActionTool(ctx: ActionContext) {
  return tool({
    name: 'attestAction',
    description:
      'Records an on-chain reputation attestation for a completed agent action by calling ' +
      'ReputationRegistry.giveFeedback(). The feedbackHash is an EIP-712 commitment to the full ' +
      'action payload. Per ADR-004: every Mainnet execute() MUST be followed by this call.',
    inputSchema: AttestActionInput,
    outputSchema: AttestActionOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeAttestAction(ctx, input),
  });
}
