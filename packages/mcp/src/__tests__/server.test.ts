import { type ConciergeTool, tool } from '@concierge/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createConciergeMcpServer } from '../server.ts';

function fakeTool(
  name: string,
  opts: Partial<{ outputSchema: z.ZodObject<z.ZodRawShape> }> = {},
): ConciergeTool {
  return tool({
    name,
    description: `fake tool ${name}`,
    inputSchema: z.object({ q: z.string() }),
    outputSchema: opts.outputSchema ?? z.object({ result: z.string() }),
    invoke: async (args) => ({ result: `echo:${args.q}` }),
  }) as ConciergeTool;
}

/** Wires the server-under-test to an in-process Client via linked transports. */
async function connect(
  tools: ReadonlyArray<ConciergeTool>,
  onToolError?: (i: { toolName: string; error: unknown }) => void,
) {
  const server = createConciergeMcpServer({
    tools,
    onEmptyToolset: () => {
      /* suppress in tests */
    },
    ...(onToolError ? { onToolError } : {}),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

describe('createConciergeMcpServer', () => {
  it('registers ALL tools with both inputSchema and outputSchema', async () => {
    const tools = [fakeTool('alpha'), fakeTool('beta'), fakeTool('gamma')];
    const { client } = await connect(tools);
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    for (const t of list.tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.outputSchema).toBeDefined();
    }
  });

  it('happy path: tool invocation returns content + structuredContent', async () => {
    const { client } = await connect([fakeTool('echo')]);
    const res = await client.callTool({ name: 'echo', arguments: { q: 'hello' } });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('echo:hello');
    expect((res.structuredContent as { result?: string })?.result).toBe('echo:hello');
  });

  it('tool failure: isError + sanitized message + observable log + structuredContent omitted', async () => {
    const failing = tool({
      name: 'fail',
      description: 'always throws',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => {
        throw new Error('boom\n[INJECT]\nhide');
      },
    }) as ConciergeTool;
    const onToolError = vi.fn();
    const { client } = await connect([failing], onToolError);
    const res = await client.callTool({ name: 'fail', arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain("Tool 'fail' failed");
    // CWE-117: control chars stripped from upstream error message.
    expect(content[0]?.text).not.toContain('\n');
    // Round-1 (test gap 8/10): structuredContent MUST NOT leak on error.
    expect(res.structuredContent).toBeUndefined();
    // Round-1 (silent-failure CRITICAL): tool failures observable.
    expect(onToolError).toHaveBeenCalledTimes(1);
    expect(onToolError.mock.calls[0]?.[0]?.toolName).toBe('fail');
    expect(onToolError.mock.calls[0]?.[0]?.error).toBeInstanceOf(Error);
  });

  it('bigint return values stringify safely (and a regression to JSON.stringify would throw)', async () => {
    const bigTool = tool({
      name: 'big',
      description: 'returns bigint',
      inputSchema: z.object({}),
      outputSchema: z.object({ amount: z.bigint() }),
      invoke: async () => ({ amount: 12345678901234567890n }),
    }) as ConciergeTool;
    const { client } = await connect([bigTool]);
    const res = await client.callTool({ name: 'big', arguments: {} });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain('12345678901234567890');
    // Round-1 (test gap 9/10): pin the bigintSafeStringify contract — a
    // regression to plain JSON.stringify would THROW TypeError, so the
    // bigint reaching content[0].text proves the safe path was taken.
    expect(() => JSON.stringify({ amount: 12345678901234567890n })).toThrow(TypeError);
  });

  it('accepts custom server info override', () => {
    const server = createConciergeMcpServer({
      tools: [],
      info: { name: 'custom-server', version: '9.9.9' },
      onEmptyToolset: () => {},
    });
    expect(server).toBeDefined();
  });

  it('non-ZodObject inputSchema → throws with toolName + field identified', () => {
    const bad = {
      name: 'bad-input',
      description: 'has non-object input',
      inputSchema: z.string(),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    } as unknown as ConciergeTool;
    expect(() => createConciergeMcpServer({ tools: [bad] })).toThrow(/bad-input.*inputSchema/);
  });

  it('non-ZodObject outputSchema → throws with toolName + field identified', () => {
    const bad = {
      name: 'bad-output',
      description: 'has non-object output',
      inputSchema: z.object({}),
      outputSchema: z.array(z.string()),
      invoke: async () => [],
    } as unknown as ConciergeTool;
    expect(() => createConciergeMcpServer({ tools: [bad] })).toThrow(/bad-output.*outputSchema/);
  });

  it('round-2 CWE-1321: prototype-pollution scrub via JSON.parse fixture (real wire shape)', async () => {
    // Test-analyzer #1: object literal `{__proto__: x}` sets prototype, NOT
    // own property — round-1 test was theatre. JSON.parse is the real wire
    // shape: `__proto__` and `constructor` BECOME own enumerable keys.
    const pollutedJson =
      '{"legit":"ok","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}';
    const evil = tool({
      name: 'evil',
      description: 'returns JSON.parse-shaped proto-polluted payload',
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
      invoke: async () => JSON.parse(pollutedJson) as never,
    }) as ConciergeTool;
    const { client } = await connect([evil]);
    const res = await client.callTool({ name: 'evil', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured?.['legit']).toBe('ok');
    expect(Object.hasOwn(structured, '__proto__')).toBe(false);
    expect(Object.hasOwn(structured, 'constructor')).toBe(false);
    // Defense in depth: ensure baseline Object.prototype was NOT polluted.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('round-2: scrub preserves data fields literally named "constructor" with non-object values', async () => {
    // E.g. ABI fragments / OpenAPI schemas mirroring Solidity terms.
    const legit = tool({
      name: 'legit-ctor',
      description: 'has a constructor:string field',
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
      invoke: async () => JSON.parse('{"constructor":"function abi","other":"ok"}') as never,
    }) as ConciergeTool;
    const { client } = await connect([legit]);
    const res = await client.callTool({ name: 'legit-ctor', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured?.['constructor']).toBe('function abi');
    expect(structured?.['other']).toBe('ok');
  });

  it('round-2: scrub preserves Date/Map/Set/Uint8Array values (not flattened to {})', async () => {
    const date = new Date('2026-06-13T12:00:00Z');
    const map = new Map<string, number>([['k', 1]]);
    const set = new Set([1, 2]);
    const bytes = new Uint8Array([1, 2, 3]);
    const richTool = tool({
      name: 'rich',
      description: 'returns built-ins',
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
      invoke: async () => ({ date, map, set, bytes }) as never,
    }) as ConciergeTool;
    const { client } = await connect([richTool]);
    const res = await client.callTool({ name: 'rich', arguments: {} });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured?.['date']).toBe(date);
    expect(structured?.['map']).toBe(map);
    expect(structured?.['set']).toBe(set);
    expect(structured?.['bytes']).toBe(bytes);
  });

  it('round-1: input fails Zod refinement → SDK rejects pre-handler (no onToolError fired)', async () => {
    // SDK pre-validates the FULL zod schema (shape + .min/.regex refinements)
    // before reaching our handler. Invalid input surfaces as MCP -32602; the
    // tool itself never runs, so onToolError stays silent — distinguishing
    // "user gave bad input" from "tool crashed in production".
    const strict = tool({
      name: 'strict',
      description: 'requires non-empty q',
      inputSchema: z.object({ q: z.string().min(3) }),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    }) as ConciergeTool;
    const onToolError = vi.fn();
    const { client } = await connect([strict], onToolError);
    const res = await client.callTool({ name: 'strict', arguments: { q: 'x' } });
    expect(res.isError).toBe(true);
    expect(onToolError).not.toHaveBeenCalled();
  });

  it('round-2: default onToolError writes a sanitized line to process.stderr', async () => {
    // Test-analyzer #2: default path was untested. A regression to
    // console.log would corrupt stdio MCP framing.
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const failing = tool({
        name: 'crash',
        description: 'throws with control chars',
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        invoke: async () => {
          throw new Error('boom\r\n[INJECT]');
        },
      }) as ConciergeTool;
      // NO onToolError override → exercises the default stderr path.
      const { client } = await connect([failing]);
      const res = await client.callTool({ name: 'crash', arguments: {} });
      expect(res.isError).toBe(true);
      expect(writeSpy).toHaveBeenCalled();
      const calls = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(calls).toContain("[concierge-mcp] tool 'crash' failed:");
      // CWE-117: stderr log content is sanitized.
      expect(calls).not.toContain('\r\n[INJECT]');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('round-2: empty-toolset warning fires from the factory (covers Worker path too)', () => {
    const onEmptyToolset = vi.fn();
    createConciergeMcpServer({ tools: [], onEmptyToolset });
    expect(onEmptyToolset).toHaveBeenCalledTimes(1);
  });

  it('round-2: non-empty toolset does NOT fire empty-toolset warning', () => {
    const onEmptyToolset = vi.fn();
    createConciergeMcpServer({ tools: [fakeTool('a')], onEmptyToolset });
    expect(onEmptyToolset).not.toHaveBeenCalled();
  });
});
