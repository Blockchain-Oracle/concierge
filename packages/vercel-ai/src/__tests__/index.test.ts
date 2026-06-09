// BDD coverage for the @concierge/vercel-ai adapter: ToolSet shape, v6 tool()
// field passthrough, execute→invoke delegation (incl. rejection passthrough +
// unary call), multi-factory merging, schema reference identity, empty-registry
// default, registry error propagation, type-level inference
// (InferToolInput/Output), and streamText + MockLanguageModelV3 integrations
// (happy path + tool-error surfacing).

import { type ConciergeAgentLike, type ProviderToolFactory, tool } from '@concierge/tools';
import { type InferToolInput, type InferToolOutput, streamText } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { getVercelAITools, toVercelAITool } from '../index.ts';

const agent: ConciergeAgentLike = { chainId: 5000 };

const proposeActionOutput = z.object({ summary: z.string(), riskScore: z.number() });
const proposeActionInput = z.object({ goal: z.string() });

const proposeAction = tool({
  name: 'proposeAction',
  description: 'Propose the next portfolio action for user review.',
  inputSchema: proposeActionInput,
  outputSchema: proposeActionOutput,
  invoke: async ({ goal }) => ({ summary: `plan for ${goal}`, riskScore: 2 }),
});

const getPortfolio = tool({
  name: 'getPortfolio',
  description: 'Read the current portfolio positions.',
  inputSchema: z.object({}),
  outputSchema: z.object({ positions: z.array(z.string()) }),
  invoke: async () => ({ positions: ['sUSDe'] }),
});

const factory: ProviderToolFactory = () => [proposeAction, getPortfolio];

const mockExecuteOptions = { toolCallId: 'tc-1', messages: [] };

describe('getVercelAITools', () => {
  it('returns a ToolSet with one entry per registry tool, keyed by name', () => {
    const tools = getVercelAITools(agent, [factory]);
    expect(Object.keys(tools).sort()).toEqual(['getPortfolio', 'proposeAction']);
  });

  it('maps each ConciergeTool onto the Vercel v6 tool() shape', () => {
    const tools = getVercelAITools(agent, [factory]);
    const entry = tools['proposeAction'];
    expect(entry?.description).toBe('Propose the next portfolio action for user review.');
    expect(entry?.inputSchema).toBeDefined();
    expect(entry?.outputSchema).toBeDefined();
    expect(typeof entry?.execute).toBe('function');
  });

  it('execute delegates to invoke and resolves with its exact value', async () => {
    const tools = getVercelAITools(agent, [factory]);
    const execute = tools['proposeAction']?.execute;
    if (!execute) throw new Error('proposeAction.execute missing');
    await expect(execute({ goal: 'maximize yield' }, mockExecuteOptions)).resolves.toEqual({
      summary: 'plan for maximize yield',
      riskScore: 2,
    });
  });

  it('execute calls invoke with exactly the args (Vercel ToolCallOptions never leak into the Concierge contract)', async () => {
    const calls: unknown[][] = [];
    const spyTool = tool({
      name: 'spy',
      description: 'Records invoke arguments.',
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    });
    const tools = getVercelAITools(agent, [() => [spyTool]]);
    const execute = tools['spy']?.execute;
    if (!execute) throw new Error('spy.execute missing');
    await execute({ q: 'x' }, mockExecuteOptions);
    expect(calls).toEqual([[{ q: 'x' }]]);
  });

  it('execute rejects with the original error when invoke rejects (no swallowing, no wrapping)', async () => {
    const boom = new Error('aave revert sentinel');
    const failing = tool({
      name: 'failing',
      description: 'Always rejects.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => {
        throw boom;
      },
    });
    const tools = getVercelAITools(agent, [() => [failing]]);
    const execute = tools['failing']?.execute;
    if (!execute) throw new Error('failing.execute missing');
    await expect(execute({}, mockExecuteOptions)).rejects.toBe(boom);
  });

  it('merges tools from multiple factories into one ToolSet', () => {
    const tools = getVercelAITools(agent, [() => [proposeAction], () => [getPortfolio]]);
    expect(Object.keys(tools).sort()).toEqual(['getPortfolio', 'proposeAction']);
  });

  it('passes inputSchema and outputSchema through by reference (InferUITools / structuredContent contract)', () => {
    const tools = getVercelAITools(agent, [factory]);
    expect(tools['proposeAction']?.inputSchema).toBe(proposeActionInput);
    expect(tools['proposeAction']?.outputSchema).toBe(proposeActionOutput);
  });

  it('returns an empty ToolSet when factories are omitted or empty (registry default)', () => {
    expect(getVercelAITools(agent)).toEqual({});
    expect(getVercelAITools(agent, [])).toEqual({});
  });

  it('propagates registry validation errors (duplicate tool names) without swallowing', () => {
    const dup: ProviderToolFactory = () => [proposeAction];
    expect(() => getVercelAITools(agent, [dup, dup])).toThrow(/duplicate tool name/);
  });
});

describe('toVercelAITool', () => {
  it('preserves per-tool generics: inferred input/output ≡ z.infer of the Zod schemas', () => {
    const vt = toVercelAITool(proposeAction);
    expectTypeOf<InferToolInput<typeof vt>>().toEqualTypeOf<z.infer<typeof proposeActionInput>>();
    expectTypeOf<InferToolOutput<typeof vt>>().toEqualTypeOf<z.infer<typeof proposeActionOutput>>();
    expectTypeOf<InferToolOutput<typeof vt>>().toEqualTypeOf<{
      summary: string;
      riskScore: number;
    }>();
  });
});

describe('streamText integration', () => {
  function toolCallModel(toolName: string, input: Record<string, unknown>) {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      }),
    });
  }

  async function collectFullStream(result: ReturnType<typeof streamText>) {
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    return parts;
  }

  it('executes a model-issued tool call end-to-end and surfaces the invoke value as the tool result', async () => {
    const result = streamText({
      model: toolCallModel('proposeAction', { goal: 'maximize yield' }),
      tools: getVercelAITools(agent, [factory]),
      prompt: 'Plan my next move.',
    });

    const parts = await collectFullStream(result);

    expect(parts.filter((p) => p.type === 'error')).toEqual([]);
    const toolResult = parts.find((p) => p.type === 'tool-result');
    if (!toolResult || toolResult.type !== 'tool-result') {
      throw new Error('no tool-result part emitted');
    }
    expect(toolResult.output).toEqual({ summary: 'plan for maximize yield', riskScore: 2 });
  });

  it('surfaces a rejecting invoke as a diagnosable tool-error part carrying the original error', async () => {
    const boom = new Error('borrow reverted: E-Mode not set');
    const failing = tool({
      name: 'failing',
      description: 'Always rejects.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => {
        throw boom;
      },
    });

    const result = streamText({
      model: toolCallModel('failing', {}),
      tools: getVercelAITools(agent, [() => [failing]]),
      prompt: 'Trigger the failure.',
    });

    const parts = await collectFullStream(result);

    expect(parts.find((p) => p.type === 'tool-result')).toBeUndefined();
    const toolError = parts.find((p) => p.type === 'tool-error');
    if (!toolError || toolError.type !== 'tool-error') {
      throw new Error('no tool-error part emitted');
    }
    expect(toolError.error).toBe(boom);
  });
});
