// BDD coverage for the @concierge/vercel-ai adapter: ToolSet shape, v6 tool()
// field passthrough, execute→invoke delegation, schema reference identity,
// empty-registry default, registry error propagation, type-level inference
// (InferToolInput/Output), and a streamText + MockLanguageModelV3 integration.

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
  it('executes a model-issued tool call end-to-end and surfaces the invoke value as the tool result', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'proposeAction',
            input: JSON.stringify({ goal: 'maximize yield' }),
          },
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

    const result = streamText({
      model,
      tools: getVercelAITools(agent, [factory]),
      prompt: 'Plan my next move.',
    });

    const parts = [];
    for await (const part of result.fullStream) parts.push(part);

    expect(parts.filter((p) => p.type === 'error')).toEqual([]);
    const toolResult = parts.find((p) => p.type === 'tool-result');
    if (!toolResult || toolResult.type !== 'tool-result') {
      throw new Error('no tool-result part emitted');
    }
    expect(toolResult.output).toEqual({ summary: 'plan for maximize yield', riskScore: 2 });
  });
});
