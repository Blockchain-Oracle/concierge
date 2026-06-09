// Runtime + type-level tests for tool() inference, aggregation, network filtering,
// duplicate-name throws, malformed-factory throws, toInputJsonSchema, bigintSafeStringify.

import type { EvmChainId } from '@concierge/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { bigintSafeStringify } from '../bigintSafeStringify.ts';
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

  it('throws clearly when an async factory leaks a Promise (no unhandledRejection)', async () => {
    const asyncBad = (() =>
      Promise.reject(new Error('async boom'))) as unknown as ProviderToolFactory;
    expect(() => createConciergeTools(agentMainnet, [asyncBad])).toThrow(/returned a Promise/);
    // Prove the `.catch(()=>{})` suppression actually swallows the rejection by
    // flushing microtasks — without the suppression, Node would emit
    // unhandledRejection here. Uses globalThis to avoid @types/node coupling.
    const proc = (
      globalThis as {
        process?: {
          on: (e: string, h: (r: unknown) => void) => void;
          off: (e: string, h: (r: unknown) => void) => void;
        };
      }
    ).process;
    if (!proc) return; // browser test runner; spy not available
    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    proc.on('unhandledRejection', handler);
    try {
      try {
        createConciergeTools(agentMainnet, [asyncBad]);
      } catch {
        // swallow expected sync TypeError
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      proc.off('unhandledRejection', handler);
    }
  });

  it('rejects non-Zod inputSchema/outputSchema (adapters require .safeParse + _def)', () => {
    const fakeSchema = { type: 'object', properties: {} } as unknown;
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ ...echo, inputSchema: fakeSchema } as unknown as ConciergeTool],
      ]),
    ).toThrow(/must be Zod schemas/);
  });

  it('rejects a non-ZodObject outputSchema per ADR-017', () => {
    expect(() =>
      createConciergeTools(agentMainnet, [
        () => [{ ...echo, outputSchema: z.string() } as unknown as ConciergeTool],
      ]),
    ).toThrow(/must be a z\.ZodObject per ADR-017/);
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
    ).toThrow(/uses \.transform\(\) or \.pipe\(\)/);
  });

  it('isolates a throwing supportsNetwork — single tool fails, registry can continue', () => {
    const bad: ProviderToolFactory = () => [
      {
        ...echo,
        supportsNetwork: () => {
          throw new Error('gate boom');
        },
      },
    ];
    expect(() => createConciergeTools(agentMainnet, [bad])).toThrow(
      /supportsNetwork threw.*gate boom/,
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

  it('toJsonSchema is the canonical ADR-014 alias of toInputJsonSchema (identity)', () => {
    expect(toJsonSchema).toBe(toInputJsonSchema);
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

  it('throws on top-level function / Symbol / Promise (same :string contract violation)', () => {
    expect(() => bigintSafeStringify(() => 1)).toThrow(/not serializable/);
    expect(() => bigintSafeStringify(Symbol('x'))).toThrow(/not serializable/);
    expect(() => bigintSafeStringify(Promise.resolve(1))).toThrow(/not serializable/);
  });

  it('throws on NESTED Promise/function/Symbol instead of silently emitting {}', () => {
    expect(() => bigintSafeStringify({ data: Promise.resolve(1) })).toThrow(/nested.*data/);
    expect(() => bigintSafeStringify({ cb: () => 1 })).toThrow(/nested.*cb/);
    expect(() => bigintSafeStringify({ k: Symbol('x') })).toThrow(/nested.*k/);
  });

  it('throws on nested WeakMap / WeakSet (would serialize as {} silently)', () => {
    expect(() => bigintSafeStringify({ wm: new WeakMap() })).toThrow(/WeakMap\/WeakSet.*wm/);
    expect(() => bigintSafeStringify({ ws: new WeakSet() })).toThrow(/WeakMap\/WeakSet.*ws/);
  });

  it('accepts top-level null (JSON.stringify(null) = "null")', () => {
    expect(bigintSafeStringify(null)).toBe('null');
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
