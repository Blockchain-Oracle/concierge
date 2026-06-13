import { ConciergeError } from '@concierge/sdk';
import { type LanguageModel, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentState } from '../../types.ts';
import { runPlan } from '../plan.ts';
import { MAX_GOAL_CHARS } from '../planPrompt.ts';
import { planSchema } from '../planSchema.ts';

afterEach(() => vi.restoreAllMocks());

const STATE: AgentState = {
  agentId: 'agent-r2',
  userId: 'u',
  chain: 'mantle-sepolia',
  goal: 'idle yield',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};

const READ_TOOLS = {
  get_state: tool({
    description: 'r',
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  }),
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

const ok = JSON.stringify({ intent: 'noop', hypothesis: 'h', suggestedActions: [] });

describe('round-2: finishReason classification', () => {
  it('finishReason="content-filter" → PlanIncomplete (NOT hallucination)', async () => {
    const model = makeModel({ text: 'I cannot help with that.', finishReason: 'content-filter' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanIncomplete',
    );
  });

  it('finishReason="other" → PlanIncomplete', async () => {
    const model = makeModel({ text: ok, finishReason: 'other' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanIncomplete',
    );
  });

  it('finishReason="error" → LlmCallFailed (NOT PlanIncomplete)', async () => {
    const model = makeModel({ text: '', finishReason: 'error' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'LlmCallFailed',
    );
  });
});

describe('round-2: cause-chain leak defense (CWE-532)', () => {
  it('LlmCallFailed.cause walked recursively — no raw apikey in chain', async () => {
    const leaky = new Error('Pimlico https://api.pimlico.io/v2/x?apikey=FAKE_R2_CAUSE_KEY');
    const wrapped = new Error('wrap', { cause: leaky });
    const model = makeModel({ throws: wrapped });
    let captured: ConciergeError | undefined;
    try {
      await runPlan(STATE, { model, tools: READ_TOOLS });
    } catch (e) {
      captured = e as ConciergeError;
    }
    expect(captured?.type).toBe('LlmCallFailed');
    // Walk the entire cause chain — NONE may contain the raw key.
    let cur: unknown = captured;
    let depth = 0;
    while (cur instanceof Error && depth < 10) {
      expect(cur.message).not.toContain('FAKE_R2_CAUSE_KEY');
      cur = cur.cause;
      depth++;
    }
  });
});

describe('round-2: prototype-pollution defense (CWE-1321)', () => {
  it('JSON.parse strips __proto__ via reviver', async () => {
    const payload =
      '{"intent":"noop","hypothesis":"h","suggestedActions":[],"__proto__":{"polluted":true}}';
    const model = makeModel({ text: payload });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
    // __proto__ stripped → no pollution of Object.prototype.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('schema rejects `constructor` key on args (Zod refine fires for non-stripped keys)', () => {
    const result = planSchema.safeParse({
      intent: 'unwind',
      hypothesis: 'h',
      suggestedActions: [{ provider: 'aave', action: 'supply', args: { constructor: 1 } }],
    });
    expect(result.success).toBe(false);
  });

  it('plan.ts reviver is the AUTHORITATIVE defense (Zod normalises __proto__ away)', async () => {
    // The reviver in plan.ts strips __proto__/constructor/prototype before
    // Zod ever sees the parsed object. End-to-end pin: a runPlan with a
    // __proto__-bearing JSON payload still parses cleanly AND does not
    // pollute Object.prototype.
    const payload =
      '{"intent":"noop","hypothesis":"h","suggestedActions":[],"__proto__":{"polluted2":true}}';
    const model = makeModel({ text: payload });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
    expect(({} as Record<string, unknown>)['polluted2']).toBeUndefined();
  });
});

describe('round-2: prompt-injection containment (CWE-77)', () => {
  it('throws ConfigError on goal exceeding MAX_GOAL_CHARS (budget DoS defense)', async () => {
    const longGoal = 'x'.repeat(MAX_GOAL_CHARS + 1);
    const model = makeModel({ text: ok });
    await expect(
      runPlan({ ...STATE, goal: longGoal }, { model, tools: READ_TOOLS }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'ConfigError');
  });

  it('legitimate adversarial goal at boundary length is accepted (schema contract holds)', async () => {
    // Boundary: exactly MAX_GOAL_CHARS chars accepted. The system prompt's
    // wrapper + escape are the real defense; this test pins that the
    // length check doesn't reject legit goals.
    const model = makeModel({ text: ok });
    const out = await runPlan(
      { ...STATE, goal: 'a'.repeat(MAX_GOAL_CHARS) },
      { model, tools: READ_TOOLS },
    );
    expect(out.kind).toBe('continue');
  });
});

describe('round-2: scalar/null root rejection', () => {
  it('JSON null root → PlanSchemaViolation with rootShape=null', async () => {
    const model = makeModel({ text: 'null' });
    let captured: ConciergeError | undefined;
    try {
      await runPlan(STATE, { model, tools: READ_TOOLS });
    } catch (e) {
      captured = e as ConciergeError;
    }
    expect(captured?.type).toBe('PlanSchemaViolation');
    expect(captured?.metadata?.['rootShape']).toBe('null');
  });

  it('JSON array root → PlanSchemaViolation', async () => {
    const model = makeModel({ text: '[]' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanSchemaViolation',
    );
  });

  it('JSON scalar root (42) → PlanSchemaViolation', async () => {
    const model = makeModel({ text: '42' });
    await expect(runPlan(STATE, { model, tools: READ_TOOLS })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'PlanSchemaViolation',
    );
  });
});

describe('round-2: unwrapJson last-fence capture', () => {
  it('chooses LAST fenced block when multiple present (plan after tool echo)', async () => {
    const text =
      '```json\n{"tool":"get_state","args":{}}\n```\nNow my plan:\n```json\n' + ok + '\n```';
    const model = makeModel({ text });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
  });

  it('tight fence (no newline before closing) accepted', async () => {
    const text = '```json\n' + ok + '```';
    const model = makeModel({ text });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
  });
});

describe('round-2: orchestrator contract shape', () => {
  it('happy path returns exactly { kind: "continue" } — NOT "success"/"done"/"halt"', async () => {
    const model = makeModel({ text: ok });
    const out = await runPlan(STATE, { model, tools: READ_TOOLS });
    expect(out.kind).toBe('continue');
    // Negative assertion: pin that the discriminator is NOT one of the
    // alternate orchestrator-side tags a regression might introduce.
    expect(['success', 'done', 'halt', 'ok']).not.toContain(out.kind);
  });
});

describe('round-2: hypothesis Set vs over-broad regex', () => {
  it('rejects "<placeholder>" as bracket-wrapped marker', () => {
    expect(
      planSchema.safeParse({ intent: 'noop', hypothesis: '<placeholder>', suggestedActions: [] })
        .success,
    ).toBe(false);
  });

  it('accepts legitimate hypothesis containing < and > inside (no longer over-broad)', () => {
    // Round-1 anchored regex rejected ANY <...> wrap; round-2 narrows.
    expect(
      planSchema.safeParse({
        intent: 'noop',
        hypothesis: 'spread < 5bps, hf > 1.5, holding',
        suggestedActions: [],
      }).success,
    ).toBe(true);
  });

  it('rejects FIXME / XXX placeholders too', () => {
    for (const p of ['FIXME', 'XXX', 'TBD']) {
      expect(
        planSchema.safeParse({ intent: 'noop', hypothesis: p, suggestedActions: [] }).success,
      ).toBe(false);
    }
  });
});
