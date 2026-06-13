import { type ConciergeTool, tool } from '@concierge/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
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
async function connect(tools: ReadonlyArray<ConciergeTool>) {
  const server = createConciergeMcpServer({ tools });
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

  it('tool failure returns isError + sanitized message, does NOT crash', async () => {
    const failing = tool({
      name: 'fail',
      description: 'always throws',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => {
        throw new Error('boom\n[INJECT]\nhide');
      },
    }) as ConciergeTool;
    const { client } = await connect([failing]);
    const res = await client.callTool({ name: 'fail', arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain("Tool 'fail' failed");
    // CWE-117: control chars stripped from upstream error message.
    expect(content[0]?.text).not.toContain('\n');
  });

  it('bigint return values stringify safely (on-chain reads)', async () => {
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
  });

  it('accepts custom server info override', () => {
    const server = createConciergeMcpServer({
      tools: [],
      info: { name: 'custom-server', version: '9.9.9' },
    });
    expect(server).toBeDefined();
  });

  it('non-ZodObject schema throws at registration time (clear error)', () => {
    const badTool = {
      name: 'bad',
      description: 'has non-object input',
      inputSchema: z.string(),
      outputSchema: z.object({ ok: z.boolean() }),
      invoke: async () => ({ ok: true }),
    } as unknown as ConciergeTool;
    expect(() => createConciergeMcpServer({ tools: [badTool] })).toThrow(/must be a z\.ZodObject/);
  });
});
