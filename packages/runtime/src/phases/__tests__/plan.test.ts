import { ConciergeError } from '@concierge/sdk';
import { type LanguageModel, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentState } from '../../types.ts';
import { runPlan } from '../plan.ts';
import { planSchema } from '../planSchema.ts';
import { filterToPlanTools, isBannedToolName, PLAN_BANNED_TOOL_NAMES } from '../planTools.ts';

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
};

interface MockOpts {
  text?: string;
  finishReason?: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' | 'content-filter';
  throws?: Error;
}

function makeModel(opts: MockOpts): LanguageModel {
  // biome-ignore lint/suspicious/noExplicitAny: hand-rolled provider mock
  const m: any = {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-1',
    supportedUrls: {},
    async doGenerate() {
      if (opts.throws) throw opts.throws;
      return {
        content: opts.text !== undefined ? [{ type: 'text', text: opts.text }] : [],
        finishReason: opts.finishReason ?? 'stop',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        warnings: [],
      };
    },
  };
  return m as LanguageModel;
}

const okPayload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    intent: 'noop',
    hypothesis: 'carry positive, HF healthy',
    suggestedActions: [],
    ...extra,
  });

describe('planSchema — discriminated union over intent', () => {
  it('noop variant requires empty tuple suggestedActions', () => {
    expect(
      planSchema.safeParse({
        intent: 'noop',
        hypothesis: 'h',
        suggestedActions: [{ provider: 'a', action: 'b', args: {} }],
      }).success,
    ).toBe(false);
  });

  it('action variant requires ≥1 suggestedAction', () => {
    expect(
      planSchema.safeParse({ intent: 'unwind', hypothesis: 'h', suggestedActions: [] }).success,
    ).toBe(false);
  });

  it('action variant rejects more than 16 actions (DoS bound)', () => {
    const actions = Array.from({ length: 17 }, () => ({ provider: 'a', action: 'b', args: {} }));
    expect(
      planSchema.safeParse({ intent: 'unwind', hypothesis: 'h', suggestedActions: actions })
        .success,
    ).toBe(false);
  });

  it('action variant accepts exactly 16 actions', () => {
    const actions = Array.from({ length: 16 }, () => ({ provider: 'a', action: 'b', args: {} }));
    expect(
      planSchema.safeParse({ intent: 'unwind', hypothesis: 'h', suggestedActions: actions })
        .success,
    ).toBe(true);
  });

  it('rejects provider/action with non-token chars (space/dot)', () => {
    expect(
      planSchema.safeParse({
        intent: 'unwind',
        hypothesis: 'h',
        suggestedActions: [{ provider: 'aave v3', action: 'repay', args: {} }],
      }).success,
    ).toBe(false);
    expect(
      planSchema.safeParse({
        intent: 'unwind',
        hypothesis: 'h',
        suggestedActions: [{ provider: 'aave', action: 'sup.ply', args: {} }],
      }).success,
    ).toBe(false);
  });

  it.each([
    '[REDACTED]',
    'TODO',
    'N/A',
    '...',
    '<your hypothesis here>',
    '{{hypothesis}}',
    'placeholder',
    'TBD',
  ])('rejects placeholder hypothesis: %s', (placeholder) => {
    expect(
      planSchema.safeParse({ intent: 'noop', hypothesis: placeholder, suggestedActions: [] })
        .success,
    ).toBe(false);
  });

  it('rejects hypothesis exceeding 2000 chars', () => {
    expect(
      planSchema.safeParse({
        intent: 'noop',
        hypothesis: 'a'.repeat(2001),
        suggestedActions: [],
      }).success,
    ).toBe(false);
  });

  it('compile-time narrowing works on the union', () => {
    const parsed = planSchema.safeParse({ intent: 'noop', hypothesis: 'h', suggestedActions: [] });
    if (parsed.success && parsed.data.intent === 'noop') {
      // Tuple type — TS knows length is 0.
      const _t: readonly [] = parsed.data.suggestedActions;
      expect(_t).toEqual([]);
    }
  });
});

describe('runPlan — error classification', () => {
  it('LlmCallFailed on generateText throw', async () => {
    const model = makeModel({
      throws: new Error('429 rate limit at https://x/v2/rpc?apikey=FAKE_PLAN_KEY'),
    });
    let captured: ConciergeError | undefined;
    try {
      await runPlan(STATE, { model, tools: READ_TOOLS });
    } catch (e) {
      captured = e as ConciergeError;
    }
    expect(captured).toBeInstanceOf(ConciergeError);
    expect(captured?.type).toBe('LlmCallFailed');
    // SECURITY: apikey sanitized in error message.
    expect(captured?.message).not.toContain('FAKE_PLAN_KEY');
    expect(captured?.message).toContain('<redacted>');
  });

  it('PlanIncomplete on empty result.text', async () => {
    const model = makeModel({ text: '' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanIncomplete',
    );
  });

  it('PlanIncomplete on finishReason="length" (truncation)', async () => {
    const model = makeModel({ text: '{"partial', finishReason: 'length' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanIncomplete',
    );
  });

  it('PlanIncomplete on finishReason="tool-calls" (step-cap exhausted)', async () => {
    const model = makeModel({ text: 'thinking...', finishReason: 'tool-calls' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanIncomplete',
    );
  });

  it('PlanSchemaViolation rawOutput is sanitized + length-capped at 1000', async () => {
    // 5000-char payload with embedded apikey URL.
    const garbage = 'x'.repeat(2000) + ' apikey=FAKE_RAW_KEY ' + 'y'.repeat(3000);
    const model = makeModel({ text: garbage });
    let captured: ConciergeError | undefined;
    try {
      await runPlan(STATE, { model, tools: READ_TOOLS });
    } catch (e) {
      captured = e as ConciergeError;
    }
    expect(captured?.type).toBe('PlanSchemaViolation');
    const raw = captured?.metadata?.['rawOutput'] as string;
    expect(raw.length).toBeLessThanOrEqual(1000);
    // Within the 1000-char window the FAKE_RAW_KEY would have appeared at
    // position ~2000+, so this assertion checks the SLICE-then-SANITIZE order.
    // Use a payload where the key is within the first 1000 chars.
    const garbage2 = 'https://x/v2/rpc?apikey=FAKE_RAW_KEY_2 ' + 'z'.repeat(2000);
    const m2 = makeModel({ text: garbage2 });
    let c2: ConciergeError | undefined;
    try {
      await runPlan(STATE, { model: m2, tools: READ_TOOLS });
    } catch (e) {
      c2 = e as ConciergeError;
    }
    const raw2 = c2?.metadata?.['rawOutput'] as string;
    expect(raw2).toContain('<redacted>');
    expect(raw2).not.toContain('FAKE_RAW_KEY_2');
  });
});

describe('runPlan — happy paths', () => {
  it('NOOP → Plan{ intent:"noop", providerCalls:[] }', async () => {
    const model = makeModel({ text: okPayload() });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') {
      expect(out.data.intent).toBe('noop');
      expect(out.data.providerCalls).toEqual([]);
    }
  });

  it('unwind → providerCalls match suggestedActions directly (no rename layer)', async () => {
    const model = makeModel({
      text: JSON.stringify({
        intent: 'unwind',
        hypothesis: 'carry inverted',
        suggestedActions: [
          { provider: 'aave-v3-mantle', action: 'repay', args: { asset: 'USDC', amount: '100' } },
        ],
      }),
    });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    if (out.kind === 'continue') {
      expect(out.data.intent).toBe('unwind');
      expect(out.data.providerCalls[0]).toEqual({
        provider: 'aave-v3-mantle',
        action: 'repay',
        args: { asset: 'USDC', amount: '100' },
      });
    }
  });

  it('accepts JSON wrapped in ```json fences', async () => {
    const model = makeModel({ text: '```json\n' + okPayload() + '\n```' });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
  });

  it('accepts JSON wrapped in fences WITH preamble (hardened unwrap)', async () => {
    const model = makeModel({
      text: 'Here is my plan:\n```json\n' + okPayload() + '\n```\nThanks!',
    });
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
    expect(() => filterToPlanTools({ supply: readTool('s'), bridge: readTool('b') })).toThrow(
      /result is empty/,
    );
  });

  it('does not mutate input', () => {
    const input = { get_state: readTool('g'), supply: readTool('s') };
    filterToPlanTools(input);
    expect(Object.keys(input).sort()).toEqual(['get_state', 'supply']);
  });

  it('isBannedToolName narrows for every banned name', () => {
    for (const name of PLAN_BANNED_TOOL_NAMES) {
      expect(isBannedToolName(name)).toBe(true);
    }
    expect(isBannedToolName('get_state')).toBe(false);
    expect(isBannedToolName('mystery')).toBe(false);
  });
});
