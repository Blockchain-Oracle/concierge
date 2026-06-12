import { ConciergeError } from '@concierge/sdk';
import { identityRegistryAbi } from '@concierge/shared/abi';
import { tool } from '@concierge/tools';
import { decodeEventLog, zeroAddress } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../_context.ts';

export const RegisterAgentInput = z.object({
  agentURI: z.string().optional().describe('Optional metadata URI for the agent NFT'),
});

export const RegisterAgentOutput = z.object({
  agentId: z.bigint().describe('Agent NFT token ID — used as agentId across all Reputation calls'),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe('Transaction hash on the source chain'),
});

type ReceiptLog = { address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` };

function findMintAgentId(
  logs: readonly ReceiptLog[],
  identityRegistry: `0x${string}`,
): bigint | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== identityRegistry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: identityRegistryAbi,
        eventName: 'Transfer',
        // biome-ignore lint/suspicious/noExplicitAny: viem expects mutable tuple; receipt.logs topics are readonly
        topics: log.topics as any,
        data: log.data,
      });
      if (decoded.args.from === zeroAddress) return decoded.args.tokenId;
    } catch {
      // IdentityRegistry log but not a Transfer mint — skip
    }
  }
  return undefined;
}

export async function executeRegisterAgent(
  ctx: ActionContext,
  input: z.infer<typeof RegisterAgentInput>,
): Promise<z.infer<typeof RegisterAgentOutput>> {
  if (!ctx.walletClient) {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/erc8004] registerAgent: walletClient is required',
    );
  }

  let txHash: `0x${string}`;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: writeContract overloads vary by account/chain binding
    txHash = await (ctx.walletClient as any).writeContract({
      address: ctx.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'register',
      args: input.agentURI !== undefined ? [input.agentURI] : [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConciergeError(
      'RpcError',
      `[@concierge/erc8004] registerAgent: register() failed — ${msg}`,
      err,
    );
  }

  const receipt = await ctx.publicClient
    .waitForTransactionReceipt({ hash: txHash })
    .catch((err: unknown) => {
      throw new ConciergeError(
        'RpcError',
        `[@concierge/erc8004] registerAgent: waitForTransactionReceipt failed — ${txHash}`,
        err,
      );
    });

  if (receipt.status === 'reverted') {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/erc8004] registerAgent: transaction reverted — ${txHash}`,
    );
  }

  const agentId = findMintAgentId(receipt.logs, ctx.identityRegistry);
  if (agentId === undefined) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/erc8004] registerAgent: no Transfer mint event found in receipt ${txHash} — the register() call may have reverted silently`,
    );
  }
  return { agentId, txHash };
}

export function createRegisterAgentTool(ctx: ActionContext) {
  return tool({
    name: 'registerAgent',
    description:
      'Mints a new agent NFT on the ERC-8004 IdentityRegistry. Returns the agentId (tokenId) needed for all attestation calls. ' +
      'Must be called once per agent before any attestAction calls.',
    inputSchema: RegisterAgentInput,
    outputSchema: RegisterAgentOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeRegisterAgent(ctx, input),
  });
}
