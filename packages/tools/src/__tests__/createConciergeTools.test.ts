// Runtime + type-level tests for tool() inference, aggregation, network filtering,
// duplicate-name throws, malformed-factory throws, toInputJsonSchema.
// bigintSafeStringify tests live in bigintSafeStringify.test.ts.

import type { EvmChainId } from '@concierge/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createConciergeTools } from '../createConciergeTools.ts';
import { SerializableProposalCardSchema, TICK_PHASE_VALUES } from '../serializable.ts';
import { toInputJsonSchema, toJsonSchema, toOutputJsonSchema } from '../toJsonSchema.ts';
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

  it('throws clearly when an async factory leaks a Promise', () => {
    const asyncBad = (() =>
      Promise.reject(new Error('async boom'))) as unknown as ProviderToolFactory;
    expect(() => createConciergeTools(agentMainnet, [asyncBad])).toThrow(/returned a Promise/);
  });

  // The `.catch(() => {})` unhandledRejection-suppression test lives in
  // createConciergeTools.unhandledRejection.test.ts (Node globals + LOC cap).

  it('hints at thenable-without-catch when a `.then`-only return falls through', () => {
    const makeBad = (): unknown => {
      // biome-ignore lint/suspicious/noThenProperty: testing the thenable hint path
      return { then: (cb: (v: unknown) => void) => cb([echo]) };
    };
    const thenableBad = makeBad as unknown as ProviderToolFactory;
    expect(() => createConciergeTools(agentMainnet, [thenableBad])).toThrow(
      /thenable.*forget to await/,
    );
  });

  it('rejects non-Zod inputSchema/outputSchema (adapters require .safeParse + _def)', () => {
    const fakeSchema = { type: 'object', properties: {} } as unknown;
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ ...echo, inputSchema: fakeSchema } as unknown as ConciergeTool],
      ]),
    ).toThrow(/must be Zod schemas/);
  });

  it('rejects a non-ZodObject outputSchema', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ ...echo, outputSchema: z.string() } as unknown as ConciergeTool],
      ]),
    ).toThrow(/outputSchema must be a z\.ZodObject/);
  });

  it('rejects a .transform()-wrapped outputSchema with a transform-specific message', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [
          {
            ...echo,
            outputSchema: z.object({ x: z.string() }).transform((o) => o),
          } as unknown as ConciergeTool,
        ],
      ]),
    ).toThrow(/outputSchema use\(s\) \.transform\(\) or \.pipe\(\)/);
  });

  it('rejects a .transform()-wrapped inputSchema symmetrically with outputSchema', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [
          {
            ...echo,
            inputSchema: z.object({ x: z.string() }).transform((o) => o),
          } as unknown as ConciergeTool,
        ],
      ]),
    ).toThrow(/inputSchema use\(s\) \.transform\(\) or \.pipe\(\)/);
  });

  it('reports BOTH inputSchema and outputSchema in one error when both are transforms', () => {
    // Collect-first / throw-once UX: author fixes both fields in one trip.
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [
          {
            ...echo,
            inputSchema: z.object({ a: z.string() }).transform((o) => o),
            outputSchema: z.object({ b: z.string() }).transform((o) => o),
          } as unknown as ConciergeTool,
        ],
      ]),
    ).toThrow(/inputSchema and outputSchema use\(s\) \.transform\(\) or \.pipe\(\)/);
  });

  it('rejects a non-ZodObject inputSchema', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ ...echo, inputSchema: z.string() } as unknown as ConciergeTool],
      ]),
    ).toThrow(/inputSchema must be a z\.ZodObject/);
  });

  it('attributes a throwing supportsNetwork — error names the offending tool', () => {
    const bad: ProviderToolFactory = () => [
      {
        ...echo,
        supportsNetwork: () => {
          throw new Error('gate boom');
        },
      },
    ];
    expect(() => createConciergeTools(agentMainnet, [bad])).toThrow(
      /tool "echo"\.supportsNetwork threw.*gate boom/,
    );
  });

  it('does NOT mis-flag a payload-style thenable like { then: () => "x" } as Promise', () => {
    // Domain object: a tool whose `then` field is a function (Liquid/Handlebars
    // continuation, RxJS-style scheduler, etc.). The tightened isThenable requires
    // both then AND catch — pure data objects survive. (LLM tool output payloads
    // sometimes embed function values that JSON drops, but we don't reject early.)
    const objLike = [echo]; // factory returns a normal tool array, not a thenable
    expect(() => createConciergeTools(agentMainnet, [() => objLike])).not.toThrow();
  });

  it('rejects supportsNetwork as a non-function value', () => {
    const bad: ProviderToolFactory = () => [
      { ...echo, supportsNetwork: 42 as unknown as (id: 5000 | 5003) => boolean },
    ];
    expect(() => createConciergeTools(agentMainnet, [bad])).toThrow(
      /supportsNetwork must be a function/,
    );
  });

  it('throws on duplicate tool name across factories', () => {
    expect(() => createConciergeTools(agentMainnet, [echoFactory, echoFactory])).toThrow(
      /duplicate tool name "echo"/,
    );
  });

  it('throws fail-CLOSED when supportsNetwork returns non-boolean (with tool name)', () => {
    const bad: ProviderToolFactory = () => [
      {
        ...echo,
        supportsNetwork: () => undefined as unknown as boolean,
      },
    ];
    expect(() => createConciergeTools(agentMainnet, [bad])).toThrow(
      /tool "echo"\.supportsNetwork must return boolean/,
    );
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

  it('toJsonSchema is the canonical ADR-014 alias of toInputJsonSchema (identity)', () => {
    expect(toJsonSchema).toBe(toInputJsonSchema);
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
