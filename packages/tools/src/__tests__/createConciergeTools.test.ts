// Runtime + type-level tests for tool() inference, aggregation, network filtering,
// duplicate-name throws, malformed-factory throws, toInputJsonSchema, bigintSafeStringify.

import type { EvmChainId } from '@concierge/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { bigintSafeStringify } from '../bigintSafeStringify.ts';
import { createConciergeTools } from '../createConciergeTools.ts';
import { SerializableProposalCardSchema, TICK_PHASE_VALUES } from '../serializable.ts';
import { toInputJsonSchema, toOutputJsonSchema } from '../toJsonSchema.ts';
import { tool } from '../tool.ts';
import type {
  ConciergeAgentLike,
  ConciergeTool,
  ProviderToolFactory,
  TickPhase,
  UICardId,
} from '../types.ts';

const echo = tool({
  name: 'echo',
  description: 'Returns the input string',
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  invoke: async ({ msg }) => ({ echoed: msg }),
});

const supplyMainnetOnly = tool({
  name: 'supply',
  description: 'Aave supply (mainnet only)',
  inputSchema: z.object({ amount: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
  supportsNetwork: (id) => id === 5000,
  invoke: async () => ({ ok: true }),
});

describe('tool() type inference', () => {
  it('preserves the generic input + output types', () => {
    expectTypeOf(echo.inputSchema).toEqualTypeOf<z.ZodObject<{ msg: z.ZodString }>>();
    expectTypeOf(echo.outputSchema).toEqualTypeOf<z.ZodObject<{ echoed: z.ZodString }>>();
  });

  it('infers the invoke arg type from inputSchema', () => {
    expectTypeOf(echo.invoke).parameter(0).toEqualTypeOf<{ msg: string }>();
  });

  it('returns the input object reference unchanged', () => {
    const def = {
      name: 'x',
      description: 'd',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    };
    expect(tool(def)).toBe(def);
  });
});

describe('public type contracts', () => {
  it('ConciergeAgentLike.chainId is EvmChainId (5000 | 5003) not bare number', () => {
    expectTypeOf<ConciergeAgentLike>().toEqualTypeOf<{ chainId: EvmChainId }>();
  });

  it('UICardId is the 4-arm union backed by SerializableXxxCardSchemas', () => {
    expectTypeOf<UICardId>().toEqualTypeOf<'proposal' | 'tick' | 'portfolio' | 'reputation'>();
  });

  it('TickPhase mirrors @concierge/shared TickLoopPhase', () => {
    expectTypeOf<TickPhase>().toEqualTypeOf<
      'plan' | 'simulate' | 'propose' | 'execute' | 'record'
    >();
  });

  it('ProviderToolFactory pins the exact factory signature', () => {
    expectTypeOf<ProviderToolFactory>().toEqualTypeOf<
      // biome-ignore lint/suspicious/noExplicitAny: deliberate erasure pinned here
      (agent: ConciergeAgentLike) => Array<ConciergeTool<any, any>>
    >();
  });

  it('TICK_PHASE_VALUES contains exactly the TickPhase arms', () => {
    expect([...TICK_PHASE_VALUES].sort()).toEqual([
      'execute',
      'plan',
      'propose',
      'record',
      'simulate',
    ]);
  });
});

describe('createConciergeTools aggregation', () => {
  const agentMainnet: ConciergeAgentLike = { chainId: 5000 };
  const agentSepolia: ConciergeAgentLike = { chainId: 5003 };

  const echoFactory: ProviderToolFactory = () => [echo];
  const supplyFactory: ProviderToolFactory = () => [supplyMainnetOnly];

  it('returns [] when no factories are provided', () => {
    expect(createConciergeTools(agentMainnet)).toEqual([]);
    expect(createConciergeTools(agentMainnet, [])).toEqual([]);
  });

  it('flat-maps tools from all provider factories', () => {
    const tools = createConciergeTools(agentMainnet, [echoFactory, supplyFactory]);
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'supply']);
  });

  it('filters out tools where supportsNetwork rejects the chain', () => {
    const tools = createConciergeTools(agentSepolia, [supplyFactory, echoFactory]);
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('keeps tools that omit supportsNetwork (default true)', () => {
    expect(createConciergeTools(agentSepolia, [echoFactory])).toHaveLength(1);
  });

  it('forwards agent into the factory call', () => {
    let received: ConciergeAgentLike | null = null;
    createConciergeTools(agentMainnet, [
      (a) => {
        received = a;
        return [];
      },
    ]);
    expect(received).toBe(agentMainnet);
  });

  it('throws on factory returning non-array (silent-failure guard)', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [() => undefined as unknown as ConciergeTool[]]),
    ).toThrow(/expected ConciergeTool\[\]/);
  });

  it('throws on tool with empty name + missing invoke + missing schemas', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ ...echo, name: '' } as unknown as ConciergeTool],
      ]),
    ).toThrow(/invalid tool/);

    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ name: 'noInvoke', description: 'd' } as unknown as ConciergeTool],
      ]),
    ).toThrow(/invalid tool/);
  });

  it('decorates factory-construction throws with the factory index', () => {
    const bad: ProviderToolFactory = () => {
      throw new Error('boom');
    };
    expect(() => createConciergeTools(agentMainnet, [bad])).toThrow(
      /factory at index 0 threw during construction.*boom/,
    );
  });

  it('throws on duplicate tool name across factories', () => {
    expect(() => createConciergeTools(agentMainnet, [echoFactory, echoFactory])).toThrow(
      /duplicate tool name "echo"/,
    );
  });

  it('throws fail-CLOSED when supportsNetwork returns non-boolean', () => {
    const bad: ProviderToolFactory = () => [
      {
        ...echo,
        supportsNetwork: () => undefined as unknown as boolean,
      },
    ];
    expect(() => createConciergeTools(agentMainnet, [bad])).toThrow(/must return boolean/);
  });
});

describe('toInputJsonSchema + toOutputJsonSchema', () => {
  const t = tool({
    name: 't',
    description: 'd',
    inputSchema: z.object({ asset: z.enum(['USDC', 'USDT']), amount: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
    invoke: async () => ({ ok: true }),
  });

  it('input schema converts to JSON Schema with type=object', () => {
    const schema = toInputJsonSchema(t) as { type: string; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required.sort()).toEqual(['amount', 'asset']);
  });

  it('output schema converts independently', () => {
    const schema = toOutputJsonSchema(t) as { type: string; properties: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.properties).toHaveProperty('ok');
  });

  it('decorates errors with the tool name when the schema is non-representable', () => {
    const bad = tool({
      name: 'badTool',
      description: 'd',
      inputSchema: z.string().transform((s) => s.length),
      outputSchema: z.object({}),
      invoke: async () => ({}),
    });
    expect(() => toInputJsonSchema(bad)).toThrow(/badTool/);
  });
});

describe('bigintSafeStringify', () => {
  it('serializes a positive bigint as a decimal string', () => {
    expect(bigintSafeStringify({ amount: 1234567890n })).toBe('{"amount":"1234567890"}');
  });

  it('serializes a negative bigint', () => {
    expect(bigintSafeStringify({ debt: -42n })).toBe('{"debt":"-42"}');
  });

  it('serializes Map entries as an object', () => {
    expect(bigintSafeStringify({ m: new Map([['a', 1n]]) })).toBe('{"m":{"a":"1"}}');
  });

  it('serializes Set entries as an array', () => {
    expect(bigintSafeStringify({ s: new Set([1n, 2n]) })).toBe('{"s":["1","2"]}');
  });

  it('throws a contextualized error on circular references (engine-native detection)', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj['self'] = obj;
    expect(() => bigintSafeStringify(obj)).toThrow(/[Cc]ircular/);
  });

  it('does NOT throw on shared-reference DAGs (positions[shared, shared])', () => {
    const shared = { ref: 1n };
    expect(bigintSafeStringify({ positions: [shared, shared] })).toBe(
      '{"positions":[{"ref":"1"},{"ref":"1"}]}',
    );
  });

  it('throws on top-level undefined (JSON.stringify(undefined) returns undefined, not "undefined")', () => {
    expect(() => bigintSafeStringify(undefined)).toThrow(/undefined/);
  });

  it('leaves plain numbers + strings untouched', () => {
    expect(bigintSafeStringify({ n: 42, s: 'hi' })).toBe('{"n":42,"s":"hi"}');
  });
});

describe('cross-cutting: tool().outputSchema can BE a SerializableXxxSchema', () => {
  it('typechecks the proposal-card binding without widening generics', () => {
    const proposeTool = tool({
      name: 'propose',
      description: 'd',
      inputSchema: z.object({}),
      outputSchema: SerializableProposalCardSchema,
      uiCardId: 'proposal',
      invoke: async () => ({
        id: 'p_1',
        actionSummary: 'do',
        estimatedAprDelta: 0,
        expiresAt: '2026-06-09T00:00:00Z',
      }),
    });
    expectTypeOf(proposeTool.outputSchema).toEqualTypeOf<typeof SerializableProposalCardSchema>();
    expect(proposeTool.outputSchema).toBe(SerializableProposalCardSchema);
  });
});
