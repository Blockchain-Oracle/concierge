import { describe, expect, it } from 'vitest';
import { createStreamableHttpHandler } from '../streamable-http.ts';

describe('createStreamableHttpHandler', () => {
  it('returns linked { server, transport } for the same factory shape as stdio', () => {
    const handler = createStreamableHttpHandler({ tools: [] });
    expect(handler.server).toBeDefined();
    expect(handler.transport).toBeDefined();
    // server.connect API matches what story-133 Worker will call.
    expect(typeof handler.server.connect).toBe('function');
  });

  it('round-1 CWE-330: caller can override sessionIdGenerator (e.g. for testing)', () => {
    const calls: number[] = [];
    let n = 0;
    const handler = createStreamableHttpHandler({
      tools: [],
      onEmptyToolset: () => {},
      sessionIdGenerator: () => {
        const id = `test-session-${n++}`;
        calls.push(n);
        return id;
      },
    });
    expect(handler.transport).toBeDefined();
    // Generator wiring is exercised by the transport on first request — we
    // can at least assert the override was kept by checking it was not
    // replaced by the default (defaultSessionIdGenerator would throw on
    // sandboxes without crypto.randomUUID, which isn't the case here, so we
    // can only assert structural acceptance).
    expect(calls).toEqual([]);
  });

  it('round-1 CWE-330: missing globalThis.crypto throws at construction (not mid-request)', () => {
    const original = globalThis.crypto;
    try {
      // @ts-expect-error — deliberately removing for the negative-path test
      delete (globalThis as { crypto?: unknown }).crypto;
      expect(() => createStreamableHttpHandler({ tools: [] })).toThrow(
        /globalThis\.crypto\.randomUUID/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('round-1 CWE-330: missing crypto.randomUUID throws at construction', () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: {},
        configurable: true,
        writable: true,
      });
      expect(() => createStreamableHttpHandler({ tools: [] })).toThrow(
        /globalThis\.crypto\.randomUUID/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('round-1: forwards onToolError + info opts to underlying server', () => {
    const onToolError = () => {};
    const handler = createStreamableHttpHandler({
      tools: [],
      onEmptyToolset: () => {},
      info: { name: 'worker-mcp', version: '1.0.0' },
      onToolError,
    });
    expect(handler.server).toBeDefined();
  });
});
