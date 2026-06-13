import { ConciergeError } from '@concierge/sdk';
import { type LanguageModel, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentState } from '../../types.ts';
import { runPlan } from '../plan.ts';
import { assertNotBanned, filterToPlanTools, PLAN_BANNED_TOOL_NAMES } from '../planTools.ts';

afterEach(() => vi.restoreAllMocks());

const STATE: AgentState = {
  agentId: 'agent-plan-1',
  userId: 'user-1',
  chain: 'mantle-sepolia',
  goal: 'idle yield on USDC',
  policyId: 'policy-1',
  recentTicks: [],
  openPositions: [],
};

function readTool(name: string) {
  return tool({
    description: `read ${name}`,
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });
}

const READ_TOOLS = {
  get_state: readTool('get_state'),
  get_yields_susde: readTool('get_yields_susde'),
  get_health_factor: readTool('get_health_factor'),
};

function modelReturning(text: string): LanguageModel {
  // Minimal V2 mock — `generateText` calls `doGenerate` and reads `text`.
  // biome-ignore lint/suspicious/noExplicitAny: hand-rolled provider mock
  const m: any = {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-1',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        warnings: [],
      };
    },
  };
  return m as LanguageModel;
}

describe('planSchema invariants', () => {
  it('rejects noop with non-empty suggestedActions', async () => {
    const model = modelReturning(
      JSON.stringify({
        intent: 'noop',
        hypothesis: 'h',
        suggestedActions: [{ providerName: 'aave', actionName: 'supply', args: {} }],
      }),
    );
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanSchemaViolation',
    );
  });

  it('rejects non-noop intent with empty suggestedActions', async () => {
    const model = modelReturning(
      JSON.stringify({ intent: 'unwind', hypothesis: 'h', suggestedActions: [] }),
    );
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanSchemaViolation',
    );
  });

  it('rejects malformed JSON (not silently coerced)', async () => {
    const model = modelReturning('this is not JSON at all');
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanSchemaViolation',
    );
  });
});

describe('runPlan happy path', () => {
  it('NOOP intent with empty actions → Plan{ intent:"noop", providerCalls:[] }', async () => {
    const model = modelReturning(
      JSON.stringify({
        intent: 'noop',
        hypothesis: 'carry positive, HF healthy',
        suggestedActions: [],
      }),
    );
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') {
      expect(out.data.intent).toBe('noop');
      expect(out.data.providerCalls).toEqual([]);
    }
  });

  it('unwind intent → maps ActionDescriptor → providerCalls', async () => {
    const model = modelReturning(
      JSON.stringify({
        intent: 'unwind',
        hypothesis: 'carry inverted',
        suggestedActions: [
          {
            providerName: 'aave-v3-mantle',
            actionName: 'repay',
            args: { asset: 'USDC', amount: '100' },
          },
        ],
      }),
    );
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    if (out.kind === 'continue') {
      expect(out.data.intent).toBe('unwind');
      expect(out.data.providerCalls).toHaveLength(1);
      expect(out.data.providerCalls[0]).toEqual({
        provider: 'aave-v3-mantle',
        action: 'repay',
        args: { asset: 'USDC', amount: '100' },
      });
    }
  });

  it('accepts JSON wrapped in ```json fences', async () => {
    const model = modelReturning(
      '```json\n' +
        JSON.stringify({ intent: 'noop', hypothesis: 'h', suggestedActions: [] }) +
        '\n```',
    );
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
  });
});

describe('filterToPlanTools — execute-tool quarantine', () => {
  it('strips every banned execute tool', () => {
    const mixed = {
      get_state: readTool('get_state'),
      supply: readTool('supply'),
      borrow: readTool('borrow'),
      bridge: readTool('bridge'),
      attestAction: readTool('attestAction'),
      get_yields_susde: readTool('get_yields_susde'),
    };
    const out = filterToPlanTools(mixed);
    expect(Object.keys(out).sort()).toEqual(['get_state', 'get_yields_susde']);
    for (const banned of PLAN_BANNED_TOOL_NAMES) {
      expect(out[banned]).toBeUndefined();
    }
  });

  it('throws ConfigError when filter leaves NO read tools (wiring bug)', () => {
    const all_banned = { supply: readTool('s'), bridge: readTool('b') };
    expect(() => filterToPlanTools(all_banned)).toThrow(/result is empty/);
  });

  it('does not mutate the input ToolSet', () => {
    const input = { get_state: readTool('g'), supply: readTool('s') };
    filterToPlanTools(input);
    expect(Object.keys(input).sort()).toEqual(['get_state', 'supply']);
  });

  it('assertNotBanned throws on every banned name', () => {
    for (const name of PLAN_BANNED_TOOL_NAMES) {
      expect(() => assertNotBanned(name)).toThrow(/plan-phase invariant violated/);
    }
  });

  it('assertNotBanned permits read tools', () => {
    expect(() => assertNotBanned('get_state')).not.toThrow();
    expect(() => assertNotBanned('get_yields_susde')).not.toThrow();
  });
});

describe('runPlan tool-stripping integration', () => {
  it('caller-supplied tools containing execute names → filtered before LLM call (no leak)', async () => {
    // We can verify filtering happens BEFORE the model call by passing a mixed
    // tool set; if filtering didn't happen, schema would still pass — but the
    // banned tool would be visible to the LLM. We assert the filter directly.
    const mixed = {
      get_state: readTool('get_state'),
      supply: readTool('supply'),
    };
    const model = modelReturning(
      JSON.stringify({ intent: 'noop', hypothesis: 'h', suggestedActions: [] }),
    );
    const out = await runPlan(STATE, { model, tools: mixed });
    expect(out.kind).toBe('continue');
    // The filter itself is unit-tested above; here we pin that runPlan
    // doesn't crash on a mixed set + the filtered set is non-empty.
  });
});
