import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markPrefixForCaching } from '../cache.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

type ContentBlock = Anthropic.TextBlockParam;
type Tool = Anthropic.Tool;

function txt(text: string): ContentBlock {
  return { type: 'text', text };
}
function tool(name: string): Tool {
  return { name, description: `tool ${name}`, input_schema: { type: 'object', properties: {} } };
}

describe('markPrefixForCaching', () => {
  it('marks the LAST system block AND LAST tool only', () => {
    const system = [txt('sys1'), txt('sys2'), txt('sys3')];
    const tools = [tool('a'), tool('b')];
    const out = markPrefixForCaching({ system, tools });
    expect(out.system?.[0]?.cache_control).toBeUndefined();
    expect(out.system?.[1]?.cache_control).toBeUndefined();
    expect(out.system?.[2]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(out.tools?.[0]?.cache_control).toBeUndefined();
    expect(out.tools?.[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT mutate inputs (array reference AND block contents)', () => {
    const system = [txt('sys1'), txt('sys2')];
    const tools = [tool('a')];
    const out = markPrefixForCaching({ system, tools });
    expect(out.system).not.toBe(system);
    expect(out.tools).not.toBe(tools);
    expect(system[1]?.cache_control).toBeUndefined();
    expect(tools[0]?.cache_control).toBeUndefined();
    // Cloned trailing block is a different object so mutating out cannot leak.
    expect(out.system?.[1]).not.toBe(system[1]);
  });

  it('drops empty arrays from the result AND warns on empty input', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = markPrefixForCaching({ system: [txt('s')], tools: [] });
    expect(out.system).toBeDefined();
    expect(out.tools).toBeUndefined();
    // Canonical entry point now propagates the empty-array warn (code-reviewer I2 fix).
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty tools array'));
  });

  it('warns when system is empty too', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = markPrefixForCaching({ system: [], tools: [tool('a')] });
    expect(out.system).toBeUndefined();
    expect(out.tools).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty system array'));
  });

  it('returns {} for missing system + tools (no warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(markPrefixForCaching({})).toEqual({});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
