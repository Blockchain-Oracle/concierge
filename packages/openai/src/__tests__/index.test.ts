// BDD coverage for the @concierge/openai adapter: raw Chat Completions
// function-tool shape (no SDK wrapped), OpenAPI-3 `parameters` emission
// (incl. near-exact wire content for defaults/optionals/enums — the coverage
// of record until packages/tools grows a toJsonSchema.test.ts), dispatch with
// string/object args (parse-before-invoke invariant, malformed/non-object
// JSON, unknown-tool + empty-registry errors, rejection passthrough by
// identity), registry behavior passthrough (multi-factory merge, chain
// gating, empty default, duplicate-name error), single-tool toOpenAITool
// conversion (pipe + non-object guards, toJsonSchema attribution), type-level
// compat with the `openai` SDK, the Anthropic key-rename recipe, and the
// re-exported bigintSafeStringify for wei-scale tool results.

import type Anthropic from '@anthropic-ai/sdk';
import { type ConciergeAgentLike, type ProviderToolFactory, tool } from '@concierge/tools';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bigintSafeStringify, getOpenAITools, toOpenAITool } from '../index.ts';

const agent: ConciergeAgentLike = { chainId: 5000 };

const proposeAction = tool({
  name: 'proposeAction',
  description: 'Propose the next portfolio action for user review.',
  inputSchema: z.object({ goal: z.string() }),
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

describe('getOpenAITools — toolkit shape', () => {
  it('returns one Chat Completions function tool per registry tool with name and description', () => {
    const { tools } = getOpenAITools(agent, [factory]);
    expect(tools.map((t) => t.function.name).sort()).toEqual(['getPortfolio', 'proposeAction']);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(typeof t.function.description).toBe('string');
    }
  });

  it('emits parameters as an OpenAPI-3 object JSON Schema derived from inputSchema', () => {
    const { tools } = getOpenAITools(agent, [factory]);
    const propose = tools.find((t) => t.function.name === 'proposeAction');
    if (!propose) throw new Error('proposeAction missing');
    expect(propose.function.parameters).toMatchObject({
      type: 'object',
      properties: { goal: { type: 'string' } },
      required: ['goal'],
    });
  });

  it('emits near-exact wire content for defaults, optionals, and enums', () => {
    const move = tool({
      name: 'move',
      description: 'Wire-content fixture covering default/enum/optional emission.',
      inputSchema: z.object({
        amount: z.number().default(1),
        token: z.enum(['USDC', 'USDT']),
        note: z.string().optional(),
      }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    });
    const { tools } = getOpenAITools(agent, [() => [move]]);
    // toEqual (not toMatchObject): freezes the surprising parts of zod's
    // openapi-3.0 emission — defaulted props STAY in `required` (parse fills
    // them; the model needn't send them), only .optional() leaves it, and
    // additionalProperties:false is always present.
    expect(tools[0]?.function.parameters).toEqual({
      type: 'object',
      properties: {
        amount: { type: 'number', default: 1 },
        token: { type: 'string', enum: ['USDC', 'USDT'] },
        note: { type: 'string' },
      },
      required: ['amount', 'token'],
      additionalProperties: false,
    });
  });

  it('merges tools from multiple factories into one array', () => {
    const { tools } = getOpenAITools(agent, [() => [proposeAction], () => [getPortfolio]]);
    expect(tools.map((t) => t.function.name).sort()).toEqual(['getPortfolio', 'proposeAction']);
  });

  it('returns an empty tools array when factories are omitted or empty (registry default)', () => {
    expect(getOpenAITools(agent).tools).toEqual([]);
    expect(getOpenAITools(agent, []).tools).toEqual([]);
  });

  it('chain-gated tools are absent from BOTH tools and dispatch (one registry snapshot)', async () => {
    const gated = tool({
      name: 'gated',
      description: 'Only supported on a different chain.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      supportsNetwork: (chainId) => chainId !== 5000,
      invoke: async () => ({ ok: true }),
    });
    const toolkit = getOpenAITools(agent, [() => [gated, getPortfolio]]);
    expect(toolkit.tools.map((t) => t.function.name)).toEqual(['getPortfolio']);
    await expect(toolkit.dispatch('gated', {})).rejects.toThrow(/unknown tool "gated"/i);
  });

  it('propagates registry validation errors (duplicate tool names) without swallowing', () => {
    const dup: ProviderToolFactory = () => [proposeAction];
    expect(() => getOpenAITools(agent, [dup, dup])).toThrow(/duplicate tool name/);
  });
});

describe('getOpenAITools — dispatch', () => {
  it('dispatches a JSON-string arguments payload (the Chat Completions wire format) to invoke', async () => {
    // Destructured on purpose: dispatch closes over its registry snapshot
    // and must never depend on `this`.
    const { dispatch } = getOpenAITools(agent, [factory]);
    await expect(dispatch('proposeAction', '{"goal":"maximize yield"}')).resolves.toEqual({
      summary: 'plan for maximize yield',
      riskScore: 2,
    });
  });

  it('dispatches an already-parsed object payload (the Anthropic tool_use format) identically', async () => {
    const toolkit = getOpenAITools(agent, [factory]);
    await expect(toolkit.dispatch('proposeAction', { goal: 'maximize yield' })).resolves.toEqual({
      summary: 'plan for maximize yield',
      riskScore: 2,
    });
  });

  it('parses input before invoke — defaults applied, unknown keys stripped (cross-adapter invariant)', async () => {
    const received: unknown[] = [];
    const recorder = tool({
      name: 'recorder',
      description: 'Records the exact args invoke receives.',
      inputSchema: z.object({ goal: z.string(), urgency: z.string().default('normal') }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async (args) => {
        received.push(args);
        return { ok: true };
      },
    });
    const toolkit = getOpenAITools(agent, [() => [recorder]]);
    await toolkit.dispatch('recorder', JSON.stringify({ goal: 'hedge', slippage: 99 }));
    expect(received).toEqual([{ goal: 'hedge', urgency: 'normal' }]);
  });

  it('rejects invalid input via zod validation before reaching ConciergeTool.invoke', async () => {
    const received: unknown[] = [];
    const recorder = tool({
      name: 'recorder',
      description: 'Records whether invoke was ever reached.',
      inputSchema: z.object({ goal: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async (args) => {
        received.push(args);
        return { ok: true };
      },
    });
    const toolkit = getOpenAITools(agent, [() => [recorder]]);
    await expect(toolkit.dispatch('recorder', { goal: 42 })).rejects.toBeInstanceOf(z.ZodError);
    await expect(toolkit.dispatch('recorder', { goal: 42 })).rejects.toThrow(/expected string/i);
    expect(received).toEqual([]);
  });

  it('rejects a JSON "null" arguments string with a ZodError (valid JSON, not an object)', async () => {
    // Models do emit arguments: "null" on no-arg tools — it parses fine, so
    // the zod gate, not JSON.parse, must be what rejects it.
    const toolkit = getOpenAITools(agent, [factory]);
    await expect(toolkit.dispatch('getPortfolio', 'null')).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects with a tool-attributed SyntaxError on malformed JSON-string arguments', async () => {
    const toolkit = getOpenAITools(agent, [factory]);
    await expect(toolkit.dispatch('proposeAction', '{not json')).rejects.toThrow(SyntaxError);
    await expect(toolkit.dispatch('proposeAction', '{not json')).rejects.toThrow(
      /dispatch\("proposeAction"\).*malformed JSON/,
    );
  });

  it('rejects loudly on an unknown tool name, listing the known tools (model hallucination guard)', async () => {
    const toolkit = getOpenAITools(agent, [factory]);
    await expect(toolkit.dispatch('nope', {})).rejects.toThrow(
      /unknown tool "nope".*getPortfolio, proposeAction/i,
    );
  });

  it('unknown-tool error on an empty registry points at the zero-tools causes instead of trailing off', async () => {
    const toolkit = getOpenAITools(agent);
    await expect(toolkit.dispatch('anything', {})).rejects.toThrow(
      /no tools are registered.*providerToolFactories.*chainId/i,
    );
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
    const toolkit = getOpenAITools(agent, [() => [failing]]);
    await expect(toolkit.dispatch('failing', {})).rejects.toBe(boom);
  });
});

describe('toOpenAITool', () => {
  it('converts a single ConciergeTool into the nested Chat Completions function-tool shape', () => {
    const t = toOpenAITool(proposeAction);
    expect(t.type).toBe('function');
    expect(t.function.name).toBe('proposeAction');
    expect(t.function.description).toBe('Propose the next portfolio action for user review.');
    expect(t.function.parameters).toMatchObject({ type: 'object' });
  });

  it('throws a TypeError naming the tool when inputSchema is not a Zod object', () => {
    const scalarInput = tool({
      name: 'scalarInput',
      description: 'Violates the registry object-schema invariant.',
      inputSchema: z.string(),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    });
    // Direct callers bypass createConciergeTools' isZodObject check; the
    // adapter must fail loudly here instead of advertising a non-object
    // `parameters` schema that OpenAI rejects at request time.
    expect(() => toOpenAITool(scalarInput)).toThrow(TypeError);
    expect(() => toOpenAITool(scalarInput)).toThrow(/scalarInput.*object/i);
  });

  it('names .transform()/.pipe() schemas specifically (actionable fix: normalize inside invoke)', () => {
    const pipedInput = tool({
      name: 'pipedInput',
      description: 'Uses a transform chain on its input schema.',
      inputSchema: z.object({ goal: z.string() }).transform((v) => v),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    });
    // z.toJSONSchema may silently convert a pipe as its first segment —
    // advertising a schema that doesn't match what parse() produces. The
    // guard turns that drift into a construction-time error.
    expect(() => toOpenAITool(pipedInput)).toThrow(TypeError);
    expect(() => toOpenAITool(pipedInput)).toThrow(/pipedInput.*transform\(\) or \.pipe\(\)/);
  });

  it('surfaces toJsonSchema attribution when a NESTED schema is unrepresentable', () => {
    const nestedTransform = tool({
      name: 'nestedTransform',
      description: 'Root is a plain ZodObject, so adapter guards pass.',
      inputSchema: z.object({ goal: z.string().transform((v) => v.length) }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    });
    // Slips past isZodPipe/isZodObject (both inspect only the root) and fails
    // inside z.toJSONSchema — the @concierge/tools wrapper must name the tool
    // and field so a multi-tool registry build is debuggable.
    expect(() => toOpenAITool(nestedTransform)).toThrow(
      /cannot convert inputSchema for tool "nestedTransform"/,
    );
  });
});

describe('SDK compatibility (type-only devDeps — never runtime imports)', () => {
  it('OpenAIFunctionTool is assignable to the openai SDK ChatCompletionFunctionTool', () => {
    // Compile-time pin: if openai@6 changes the nested function-tool shape,
    // this assignment breaks typecheck before any runtime drift ships.
    const sdkTool: ChatCompletionFunctionTool = toOpenAITool(proposeAction);
    expect(sdkTool.type).toBe('function');
  });

  it('parameters double as Anthropic input_schema via key rename (one adapter, two runtimes)', () => {
    const { tools } = getOpenAITools(agent, [factory]);
    // Direct assignment, no re-spread: OpenAIFunctionDefinition['parameters']
    // carries the literal type:'object' that Anthropic's InputSchema demands.
    const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
    expect(anthropicTools.map((t) => t.name).sort()).toEqual(['getPortfolio', 'proposeAction']);
    for (const t of anthropicTools) {
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema['properties']).toBeDefined();
    }
  });
});

describe('serialization helper re-export', () => {
  it('bigintSafeStringify serializes wei-scale bigint dispatch results for tool-result messages', async () => {
    const balance = tool({
      name: 'balance',
      description: 'Returns a wei-scale bigint balance.',
      inputSchema: z.object({}),
      outputSchema: z.object({ wei: z.bigint() }),
      invoke: async () => ({ wei: 12345678901234567890n }),
    });
    const toolkit = getOpenAITools(agent, [() => [balance]]);
    const result = await toolkit.dispatch('balance', '{}');
    expect(bigintSafeStringify(result)).toBe('{"wei":"12345678901234567890"}');
  });
});
