// BDD coverage for the @concierge/langchain adapter: StructuredToolInterface
// shape, stringified invoke delegation (incl. rejection passthrough + unary
// call), zod input validation + unknown-key stripping, schema reference
// identity, multi-factory merging, empty-registry default, registry error
// propagation, serialization safety (bigint / undefined / nested thenable),
// single-tool toLangChainTool conversion, and fakeModel + bindTools
// integrations (ToolCall → ToolMessage happy path + error propagation).

import { type ConciergeAgentLike, type ProviderToolFactory, tool } from '@concierge/tools';
import { HumanMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getLangChainTools, toLangChainTool } from '../index.ts';

const agent: ConciergeAgentLike = { chainId: 5000 };

const proposeActionInput = z.object({ goal: z.string() });

const proposeAction = tool({
  name: 'proposeAction',
  description: 'Propose the next portfolio action for user review.',
  inputSchema: proposeActionInput,
  outputSchema: z.object({ summary: z.string(), riskScore: z.number() }),
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

describe('getLangChainTools', () => {
  it('returns one StructuredToolInterface per registry tool with name, description, schema, and invoke', () => {
    const tools = getLangChainTools(agent, [factory]);
    expect(tools.map((t) => t.name).sort()).toEqual(['getPortfolio', 'proposeAction']);
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.schema).toBeDefined();
      expect(typeof t.invoke).toBe('function');
    }
  });

  it('invoke resolves to the JSON-stringified value of ConciergeTool.invoke (LangChain string contract)', async () => {
    const tools = getLangChainTools(agent, [factory]);
    const propose = tools.find((t) => t.name === 'proposeAction');
    if (!propose) throw new Error('proposeAction missing');
    await expect(propose.invoke({ goal: 'maximize yield' })).resolves.toBe(
      JSON.stringify({ summary: 'plan for maximize yield', riskScore: 2 }),
    );
  });

  it('passes inputSchema through by reference as the LangChain tool schema', () => {
    const tools = getLangChainTools(agent, [factory]);
    const propose = tools.find((t) => t.name === 'proposeAction');
    expect(propose?.schema).toBe(proposeActionInput);
  });

  it('rejects invalid input via zod validation before reaching ConciergeTool.invoke', async () => {
    const tools = getLangChainTools(agent, [factory]);
    const propose = tools.find((t) => t.name === 'proposeAction');
    if (!propose) throw new Error('proposeAction missing');
    // Compiles without @ts-expect-error because StructuredToolInterface erases
    // per-tool input generics — this test deliberately covers the RUNTIME
    // validation that backstops the erased static typing.
    await expect(propose.invoke({ goal: 42 })).rejects.toThrow(/string/i);
  });

  it('rejects with the original error when invoke rejects (no swallowing, no wrapping)', async () => {
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
    const tools = getLangChainTools(agent, [() => [failing]]);
    const lcFailing = tools.find((t) => t.name === 'failing');
    if (!lcFailing) throw new Error('failing missing');
    await expect(lcFailing.invoke({})).rejects.toBe(boom);
  });

  it('calls ConciergeTool.invoke with exactly the args (LangChain config never leaks into the Concierge contract)', async () => {
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
    const tools = getLangChainTools(agent, [() => [spyTool]]);
    const spy = tools.find((t) => t.name === 'spy');
    if (!spy) throw new Error('spy missing');
    await spy.invoke({ q: 'x' });
    expect(calls).toEqual([[{ q: 'x' }]]);
  });

  it('merges tools from multiple factories into one array', () => {
    const tools = getLangChainTools(agent, [() => [proposeAction], () => [getPortfolio]]);
    expect(tools.map((t) => t.name).sort()).toEqual(['getPortfolio', 'proposeAction']);
  });

  it('returns an empty array when factories are omitted or empty (registry default)', () => {
    expect(getLangChainTools(agent)).toEqual([]);
    expect(getLangChainTools(agent, [])).toEqual([]);
  });

  it('propagates registry validation errors (duplicate tool names) without swallowing', () => {
    const dup: ProviderToolFactory = () => [proposeAction];
    expect(() => getLangChainTools(agent, [dup, dup])).toThrow(/duplicate tool name/);
  });

  it('serializes bigint outputs as decimal strings (wei amounts must not crash stringification)', async () => {
    const weiTool = tool({
      name: 'weiBalance',
      description: 'Returns a wei-scale bigint balance.',
      inputSchema: z.object({}),
      outputSchema: z.object({ wei: z.bigint() }),
      invoke: async () => ({ wei: 12345678901234567890n }),
    });
    const tools = getLangChainTools(agent, [() => [weiTool]]);
    const lcWei = tools.find((t) => t.name === 'weiBalance');
    if (!lcWei) throw new Error('weiBalance missing');
    await expect(lcWei.invoke({})).resolves.toBe(JSON.stringify({ wei: '12345678901234567890' }));
  });

  it('rejects loudly when invoke returns undefined (never a silent empty-success ToolMessage)', async () => {
    const buggy = tool({
      name: 'buggy',
      description: 'Returns undefined in violation of its outputSchema.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => undefined as unknown as { ok: boolean },
    });
    const tools = getLangChainTools(agent, [() => [buggy]]);
    const lcBuggy = tools.find((t) => t.name === 'buggy');
    if (!lcBuggy) throw new Error('buggy missing');
    await expect(lcBuggy.invoke({})).rejects.toThrow(/not serializable/);
  });

  it('rejects loudly on nested non-serializable values instead of silently emitting {}', async () => {
    const forgotAwait = tool({
      name: 'forgotAwait',
      description: 'Leaks a pending promise into its output.',
      inputSchema: z.object({}),
      outputSchema: z.object({ tx: z.object({ hash: z.string() }) }),
      invoke: async () =>
        ({ tx: Promise.resolve({ hash: '0xabc' }) }) as unknown as { tx: { hash: string } },
    });
    const tools = getLangChainTools(agent, [() => [forgotAwait]]);
    const lcForgot = tools.find((t) => t.name === 'forgotAwait');
    if (!lcForgot) throw new Error('forgotAwait missing');
    await expect(lcForgot.invoke({})).rejects.toThrow(/thenable.*forgot to await/);
  });

  it('strips unknown input keys before invoke (zod object default — hallucinated extras never reach providers)', async () => {
    const received: unknown[] = [];
    const recorder = tool({
      name: 'recorder',
      description: 'Records the parsed input it receives.',
      inputSchema: z.object({ goal: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async (args) => {
        received.push(args);
        return { ok: true };
      },
    });
    const tools = getLangChainTools(agent, [() => [recorder]]);
    const lcRecorder = tools.find((t) => t.name === 'recorder');
    if (!lcRecorder) throw new Error('recorder missing');
    await lcRecorder.invoke({ goal: 'hedge', slippage: 99 });
    expect(received).toEqual([{ goal: 'hedge' }]);
  });
});

describe('toLangChainTool', () => {
  it('converts a single ConciergeTool with name, description, and schema passed through', async () => {
    const lc = toLangChainTool(proposeAction);
    expect(lc.name).toBe('proposeAction');
    expect(lc.description).toBe('Propose the next portfolio action for user review.');
    expect(lc.schema).toBe(proposeActionInput);
    await expect(lc.invoke({ goal: 'hedge' })).resolves.toBe(
      JSON.stringify({ summary: 'plan for hedge', riskScore: 2 }),
    );
  });
});

describe('bindTools integration', () => {
  it('routes a model-issued tool call through invoke and yields a ToolMessage with the JSON string', async () => {
    const tools = getLangChainTools(agent, [factory]);
    const model = fakeModel().respondWithTools([
      { name: 'proposeAction', args: { goal: 'maximize yield' }, id: 'call-1' },
    ]);
    const bound = model.bindTools(tools);

    const response = await bound.invoke([new HumanMessage('Plan my next move.')]);
    const toolCall = response.tool_calls?.[0];
    if (!toolCall) throw new Error('model emitted no tool call');
    expect(toolCall.name).toBe('proposeAction');

    const propose = tools.find((t) => t.name === toolCall.name);
    if (!propose) throw new Error('proposeAction missing');
    const toolMessage = await propose.invoke(toolCall);

    expect(toolMessage.tool_call_id).toBe('call-1');
    expect(toolMessage.name).toBe('proposeAction');
    expect(toolMessage.status).toBe('success');
    expect(toolMessage.content).toBe(
      JSON.stringify({ summary: 'plan for maximize yield', riskScore: 2 }),
    );
  });

  it('propagates the original invoke error through the ToolCall invocation path (no error-status ToolMessage)', async () => {
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
    const tools = getLangChainTools(agent, [() => [failing]]);
    const lcFailing = tools.find((t) => t.name === 'failing');
    if (!lcFailing) throw new Error('failing missing');
    await expect(
      lcFailing.invoke({ name: 'failing', args: {}, id: 'call-2', type: 'tool_call' }),
    ).rejects.toBe(boom);
  });
});
