import { ConciergeError } from '@concierge/sdk';
import { reputationRegistryAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import {
  AbiEventSignatureEmptyTopicsError,
  AbiEventSignatureNotFoundError,
  decodeEventLog,
} from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';
import type { ReceiptLog } from '../_types.ts';
import { hashActionPayload } from '../eip712.ts';

export const AttestActionInput = z.object({
  agentId: z.bigint().describe('Agent NFT token ID from registerAgent'),
  providerSchema: z.string().min(1).describe('Schema name e.g. concierge.aave.v3.borrow.v1'),
  actionPayload: z
    .object({ schema: z.string() })
    .catchall(z.unknown())
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

function scanForFeedbackIndex(
  logs: readonly ReceiptLog[],
  registryAddress: `0x${string}`,
): bigint | undefined {
  for (const log of logs) {
    if (log.removed === true) continue;
    if (log.address.toLowerCase() !== registryAddress.toLowerCase()) continue;
    try {
      return decodeEventLog({
        abi: reputationRegistryAbi,
        eventName: 'NewFeedback',
        // biome-ignore lint/suspicious/noExplicitAny: viem expects mutable tuple; readonly Hex[] is structurally identical
        topics: log.topics as any,
        data: log.data,
      }).args.feedbackIndex;
    } catch (err) {
      // Expected: registry log is not a NewFeedback event
      if (
        err instanceof AbiEventSignatureEmptyTopicsError ||
        err instanceof AbiEventSignatureNotFoundError
      )
        continue;
      throw new ConciergeError(
        'RpcError',
        '[@concierge/erc8004] attestAction: unexpected error decoding ReputationRegistry log',
        err,
      );
    }
  }
  return undefined;
}

function assertAttestInputValid(
  ctx: ActionContext,
  input: z.infer<typeof AttestActionInput>,
): void {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/erc8004] attestAction: walletClient is required',
    );
  }
  if (input.actionPayload.schema !== input.providerSchema) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/erc8004] attestAction: actionPayload.schema ("${input.actionPayload.schema}") must match providerSchema ("${input.providerSchema}")`,
    );
  }
}

export async function executeAttestAction(
  ctx: ActionContext,
  input: z.infer<typeof AttestActionInput>,
): Promise<z.infer<typeof AttestActionOutput>> {
  assertAttestInputValid(ctx, input);

  const feedbackHash = hashActionPayload(input.actionPayload, input.agentId, ctx.chainId);

  let txHash: `0x${string}`;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: writeContract overloads vary by account/chain binding
    txHash = await (ctx.walletClient as any).writeContract({
      address: ctx.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: 'giveFeedback',
      args: [input.agentId, 1n, 0, 'concierge.action', input.providerSchema, '', '', feedbackHash],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = /AgentNotFound/i.test(msg) ? 'AgentNotFound' : 'TxFailed';
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/erc8004] attestAction: giveFeedback reverted — ${msg}`,
      err,
      { reason, agentId: input.agentId },
    );
  }

  const receipt = await ctx.publicClient
    .waitForTransactionReceipt({ hash: txHash })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] attestAction: waitForTransactionReceipt failed for ${txHash}`,
        err,
      );
    });

  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/erc8004] attestAction: transaction reverted — ${txHash}`,
      undefined,
      { agentId: input.agentId },
    );
  }

  const feedbackIndex = scanForFeedbackIndex(receipt.logs, ctx.reputationRegistry);
  if (feedbackIndex === undefined) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/erc8004] attestAction: no NewFeedback event found in receipt ${txHash}`,
    );
  }
  return { txHash, feedbackIndex, feedbackHash };
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
