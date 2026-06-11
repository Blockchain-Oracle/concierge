import { ConciergeError } from '@concierge/sdk';
import { tool } from '@concierge/tools';
import { z } from 'zod';
import { fetchBridgeStatus } from '../_api.ts';
import type { ActionContext } from '../_context.ts';
import { TX_HASH } from '../_zod.ts';
import {
  buildCompletedAttestation,
  type CompletedAttestationPayload,
  CompletedAttestationPayloadSchema,
} from '../attestation.ts';

export const GetStatusInput = z.object({
  sourceTxHash: TX_HASH.describe('Transaction hash on the source chain'),
  lifiOperationId: z.string().min(1).describe('Li.Fi operation ID from bridge() response'),
  fromChain: z.number().int().positive().describe('Source chain ID'),
  toChain: z.number().int().positive().describe('Destination chain ID'),
});

// Note: outputSchema must be ZodObject per ADR-017 (MCP structuredContent requires object at root).
// The co-variance between status === 'DONE' and non-null attestation fields is enforced in the
// function body (throws RpcError on DONE+missing data) rather than in the schema.
export const GetStatusOutput = z.object({
  status: z.enum(['PENDING', 'DONE', 'FAILED', 'NOT_FOUND']).describe('Current bridge status'),
  destinationTxHash: TX_HASH.nullable().describe(
    'Destination-chain tx hash (populated when status === DONE)',
  ),
  bridgeUsed: z
    .string()
    .nullable()
    .describe('Bridge protocol used (populated when status === DONE)'),
  completedAttestation: CompletedAttestationPayloadSchema.nullable().describe(
    'ERC-8004 completed attestation — present only when status === DONE. Record this immediately.',
  ),
});

export async function executeGetStatus(
  ctx: ActionContext,
  input: z.infer<typeof GetStatusInput>,
): Promise<z.infer<typeof GetStatusOutput>> {
  const statusResponse = await fetchBridgeStatus({
    txHash: input.sourceTxHash,
    fromChain: input.fromChain,
    toChain: input.toChain,
    apiKey: ctx.apiKey,
  });

  const { status, toTx, tool: bridgeTool, metadata } = statusResponse;
  const destinationTxHash = toTx?.txHash ?? null;
  const bridgeUsed = bridgeTool ?? metadata?.bridges?.[0]?.name ?? null;

  if (status !== 'DONE') {
    return { status, destinationTxHash, bridgeUsed, completedAttestation: null };
  }

  // DONE but settlement data absent — Li.Fi API inconsistency, not a caller error
  if (!destinationTxHash) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] getStatus: status DONE but toTx.txHash is absent — cannot build completed attestation for operation ${input.lifiOperationId}`,
    );
  }
  if (!bridgeUsed) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/lifi-bridge] getStatus: status DONE but bridge name is absent — cannot build completed attestation for operation ${input.lifiOperationId}`,
    );
  }

  let completedAttestation: CompletedAttestationPayload;
  try {
    completedAttestation = buildCompletedAttestation({
      fromChain: input.fromChain,
      toChain: input.toChain,
      sourceTxHash: input.sourceTxHash,
      destinationTxHash,
      lifiOperationId: input.lifiOperationId,
      bridgeUsed,
    });
  } catch (err) {
    throw new ConciergeError(
      'AttestationFailed',
      `[@concierge/lifi-bridge] getStatus: bridge DONE (destinationTxHash: ${destinationTxHash}) ` +
        'but completed attestation failed — record concierge.lifi.bridge.completed.v1 manually',
      err instanceof Error ? err : undefined,
    );
  }

  return { status, destinationTxHash, bridgeUsed, completedAttestation };
}

export function createGetStatusTool(ctx: ActionContext) {
  return tool({
    name: 'getStatus',
    description:
      'Polls Li.Fi for the status of an in-flight bridge operation. Returns PENDING | DONE | FAILED | NOT_FOUND. ' +
      'When status === DONE, returns a `concierge.lifi.bridge.completed.v1` attestation to record on-chain.',
    inputSchema: GetStatusInput,
    outputSchema: GetStatusOutput,
    supportsNetwork: () => true,
    invoke: (input) => executeGetStatus(ctx, input),
  });
}
