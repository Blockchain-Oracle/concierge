// Barrel surface of the @concierge/sdk META package (story-22 amended).
// Re-exports cover @concierge/tools + @concierge/vercel-ai + the SDK's own
// defaultModel / ConciergeRegistry / ConciergeError. The @concierge/agent
// re-exports (createConcierge, Concierge) land with Epic E5 — the agent
// runtime package does not exist yet (see story-22 deferral addendum).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as sdk from '../index.ts';

describe('@concierge/sdk barrel', () => {
  it('exports the SDK-owned surface: defaultModel, ConciergeRegistry, ConciergeError', () => {
    expect(typeof sdk.defaultModel).toBe('function');
    expect(typeof sdk.ConciergeRegistry.mainnet).toBe('function');
    expect(typeof sdk.ConciergeRegistry.sepolia).toBe('function');
    expect(new sdk.ConciergeError('RpcError', 'x')).toBeInstanceOf(Error);
  });

  it('re-exports the @concierge/tools registry surface', () => {
    expect(typeof sdk.tool).toBe('function');
    expect(typeof sdk.createConciergeTools).toBe('function');
    expect(typeof sdk.bigintSafeStringify).toBe('function');
  });

  it('re-exports the serializable card schemas (load-bearing for the UI rails)', () => {
    expect(sdk.SerializableProposalCardSchema).toBeDefined();
    expect(sdk.SerializableTickCardSchema).toBeDefined();
    expect(sdk.SerializablePortfolioCardSchema).toBeDefined();
    expect(sdk.SerializableReputationCardSchema).toBeDefined();
    expect(sdk.CARD_SCHEMAS).toBeDefined();
    expect(typeof sdk.safeParseSerializableProposalCard).toBe('function');
    expect(typeof sdk.safeParseSerializableTickCard).toBe('function');
    expect(typeof sdk.safeParseSerializablePortfolioCard).toBe('function');
    expect(typeof sdk.safeParseSerializableReputationCard).toBe('function');
    expect(sdk.TICK_PHASE_VALUES).toBeDefined();
  });

  it('re-exports the Sepolia zero-address lockbox so consumers can guard programmatically', () => {
    // ConciergeRegistry.sepolia() exposes pending 0x000…000 slots until
    // story-192 deploys mocks; an SDK-only consumer needs a programmatic
    // signal (not just README prose) before sending funds anywhere.
    expect(Array.isArray(sdk.SEPOLIA_PENDING_ADDRESS_SLOTS)).toBe(true);
    expect(sdk.SEPOLIA_PENDING_ADDRESS_SLOTS.length).toBeGreaterThan(0);
  });

  it('re-exports the runtime error-type list alongside the ConciergeError class', () => {
    expect(sdk.CONCIERGE_ERROR_TYPES).toContain('EModeNotEnabled');
    expect(typeof sdk.isConciergeErrorType).toBe('function');
  });

  it('re-exports the @concierge/vercel-ai adapter surface', () => {
    expect(typeof sdk.getVercelAITools).toBe('function');
    expect(typeof sdk.toVercelAITool).toBe('function');
  });

  it('the re-exported pieces compose: registry + tool factory + vercel adapter', () => {
    const registry = sdk.ConciergeRegistry.sepolia();
    const tools = sdk.getVercelAITools(registry, [
      () => [
        sdk.tool({
          name: 'ping',
          description: 'Replies pong.',
          inputSchema: z.object({}),
          outputSchema: z.object({ pong: z.boolean() }),
          invoke: async () => ({ pong: true }),
        }),
      ],
    ]);
    expect(Object.keys(tools)).toEqual(['ping']);
  });
});
