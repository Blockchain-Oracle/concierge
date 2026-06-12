import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext } from '../_context.ts';
import { executeAttestAction } from '../actions/attestAction.ts';
import { executeReadFeedback } from '../actions/readFeedback.ts';
import { executeReadReputation } from '../actions/readReputation.ts';
import { executeRegisterAgent } from '../actions/registerAgent.ts';
import { hashActionPayload } from '../eip712.ts';
import {
  type AnvilFork,
  IDENTITY_REGISTRY_SEPOLIA,
  REPUTATION_REGISTRY_SEPOLIA,
  startAnvilFork,
} from './setup.ts';

type AttestResult = { txHash: string; feedbackIndex: bigint; feedbackHash: string };

const SCHEMAS = [
  'concierge.aave.v3.borrow.v1',
  'concierge.aave.v3.supply.v1',
  'concierge.aave.v3.borrow.v1',
  'concierge.mantle-dex.agni.swap.v1',
  'concierge.ethena.wrap.v1',
] as const;

type Schema = (typeof SCHEMAS)[number];

const PAYLOADS: Array<{ schema: Schema; amount: string }> = SCHEMAS.map((s, i) => ({
  schema: s,
  amount: String((i + 1) * 100),
}));

describe('ERC-8004 end-to-end integration — live Sepolia fork', () => {
  let fork: AnvilFork;
  let ctx: ActionContext;
  let agentId: bigint;
  let attestResults: AttestResult[];

  beforeAll(async () => {
    fork = await startAnvilFork();
    // ERC-8004 "Self-feedback not allowed": agent owner (account #0) registers;
    // client (account #1) submits giveFeedback. Read-only calls use either ctx.
    const agentCtx: ActionContext = {
      publicClient: fork.publicClient,
      // biome-ignore lint/suspicious/noExplicitAny: walletClient has correct chain binding; cast matches action expectations
      walletClient: fork.walletClient as any,
      identityRegistry: IDENTITY_REGISTRY_SEPOLIA,
      reputationRegistry: REPUTATION_REGISTRY_SEPOLIA,
      chainId: 5003,
    };
    ctx = {
      publicClient: fork.publicClient,
      // biome-ignore lint/suspicious/noExplicitAny: clientWalletClient has correct chain binding
      walletClient: fork.clientWalletClient as any,
      identityRegistry: IDENTITY_REGISTRY_SEPOLIA,
      reputationRegistry: REPUTATION_REGISTRY_SEPOLIA,
      chainId: 5003,
    };

    const reg = await executeRegisterAgent(agentCtx, {});
    agentId = reg.agentId;

    attestResults = [];
    for (const [i, schema] of SCHEMAS.entries()) {
      const payload = PAYLOADS[i] ?? { schema, amount: '0' };
      const r = await executeAttestAction(ctx, {
        agentId,
        providerSchema: schema,
        actionPayload: payload,
      });
      attestResults.push(r);
    }
  });

  afterAll(async () => {
    await fork.stop();
  });

  it('register returns agentId > 0', () => {
    expect(agentId).toBeGreaterThan(0n);
  });

  it('5 attests succeed — all txHashes are valid hex', () => {
    expect(attestResults).toHaveLength(5);
    for (const r of attestResults) {
      expect(r.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
  });

  it('each attest feedbackHash matches local EIP-712 computation', () => {
    for (const [i, r] of attestResults.entries()) {
      const payload = PAYLOADS[i] ?? { schema: SCHEMAS[0], amount: '0' };
      expect(r.feedbackHash).toBe(hashActionPayload(payload, agentId, 5003));
    }
  });

  it('readReputation: totalAttestations === 5', async () => {
    const result = await executeReadReputation(ctx, { agentId });
    expect(result.totalAttestations).toBe(5);
  });

  it('readReputation: schemaCounts reflect 4 unique schemas', async () => {
    const result = await executeReadReputation(ctx, { agentId });
    expect(Object.keys(result.schemaCounts)).toHaveLength(4);
    expect(result.schemaCounts['concierge.aave.v3.borrow.v1']).toBe(2);
    expect(result.schemaCounts['concierge.aave.v3.supply.v1']).toBe(1);
    expect(result.schemaCounts['concierge.mantle-dex.agni.swap.v1']).toBe(1);
    expect(result.schemaCounts['concierge.ethena.wrap.v1']).toBe(1);
  });

  it('readReputation: latestAttestation is non-null and has valid feedbackIndex', async () => {
    const result = await executeReadReputation(ctx, { agentId });
    expect(result.latestAttestation).not.toBeNull();
    expect(result.latestAttestation?.feedbackIndex).toBeGreaterThanOrEqual(0n);
  });

  it('readFeedback: returns 5 entries; schemas and feedbackHashes all match', async () => {
    const { entries } = await executeReadFeedback(ctx, {
      agentId,
      fromBlock: fork.forkBlockNumber,
    });
    expect(entries).toHaveLength(5);
    for (const [i, entry] of entries.entries()) {
      expect(entry.schema).toBe(SCHEMAS[i]);
      const payload = PAYLOADS[i] ?? { schema: SCHEMAS[0], amount: '0' };
      expect(entry.feedbackHash).toBe(hashActionPayload(payload, agentId, 5003));
      expect(entry.revoked).toBe(false);
    }
  });

  it('feedbackIndex values in readFeedback match attest result feedbackIndexes', async () => {
    const { entries } = await executeReadFeedback(ctx, {
      agentId,
      fromBlock: fork.forkBlockNumber,
    });
    for (const [i, entry] of entries.entries()) {
      expect(entry.feedbackIndex).toBe(attestResults[i]?.feedbackIndex);
    }
  });
});
