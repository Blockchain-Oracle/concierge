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

  // biome-ignore lint/suspicious/noExplicitAny: writeContract overloads vary by account/chain binding
  const txHash: `0x${string}` = await (ctx.walletClient as any).writeContract({
    address: ctx.identityRegistry,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: input.agentURI !== undefined ? [input.agentURI] : [],
  });

  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: identityRegistryAbi,
        eventName: 'Transfer',
        topics: log.topics,
        data: log.data,
      });
      // Transfer(0x0, owner, tokenId) is the mint event — tokenId IS the agentId
      if (decoded.args.from === zeroAddress) {
        return { agentId: decoded.args.tokenId, txHash };
      }
    } catch {
      // Log is from a different contract or event — skip
    }
  }

  throw new ConciergeError(
    'RpcError',
    `[@concierge/erc8004] registerAgent: no Transfer mint event found in receipt ${txHash} — the register() call may have reverted silently`,
  );
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
