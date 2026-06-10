// defaultModel() per ADR-016: env auto-detect with AI_MODEL="provider:model"
// override. The @ai-sdk provider factories read their API keys lazily at
// REQUEST time, so constructing a model here makes no network calls and
// needs no keys — these tests assert routing, not authentication.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultModel } from '../defaultModel.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('defaultModel (ADR-016 env auto-detect)', () => {
  it('defaults to anthropic:claude-sonnet-4-6 when AI_MODEL is unset', () => {
    vi.stubEnv('AI_MODEL', undefined);
    const model = defaultModel();
    expect(model.modelId).toBe('claude-sonnet-4-6');
    expect(model.provider).toContain('anthropic');
  });

  it('treats an empty AI_MODEL as unset (set-but-empty env vars are common)', () => {
    vi.stubEnv('AI_MODEL', '');
    expect(defaultModel().modelId).toBe('claude-sonnet-4-6');
  });

  it('routes AI_MODEL="openai:gpt-5.1" to the openai provider', () => {
    vi.stubEnv('AI_MODEL', 'openai:gpt-5.1');
    const model = defaultModel();
    expect(model.modelId).toBe('gpt-5.1');
    expect(model.provider).toContain('openai');
  });

  it('routes AI_MODEL="google:..." to the google provider', () => {
    vi.stubEnv('AI_MODEL', 'google:gemini-2.5-pro');
    const model = defaultModel();
    expect(model.modelId).toBe('gemini-2.5-pro');
    expect(model.provider).toContain('google');
  });

  it('routes an explicit "xai:..." spec to the xai provider', () => {
    const model = defaultModel('xai:grok-4');
    expect(model.modelId).toBe('grok-4');
    expect(model.provider).toContain('xai');
  });

  it('an explicit spec argument beats the AI_MODEL env var', () => {
    vi.stubEnv('AI_MODEL', 'openai:gpt-5.1');
    const model = defaultModel('anthropic:claude-opus-4-7');
    expect(model.modelId).toBe('claude-opus-4-7');
    expect(model.provider).toContain('anthropic');
  });

  it('returns the model interface version the installed providers ship (v3)', () => {
    // SDK-DX-STUDY §A: pin to whatever interface is active at story time.
    // @ai-sdk/* 3.x factories return LanguageModelV3.
    expect(defaultModel().specificationVersion).toBe('v3');
  });

  it('splits on the FIRST colon only — model ids may contain colons (OpenAI fine-tunes)', () => {
    const model = defaultModel('openai:ft:gpt-5.1:org:custom');
    expect(model.modelId).toBe('ft:gpt-5.1:org:custom');
  });

  it('throws on an unknown provider, naming the known ones', () => {
    expect(() => defaultModel('mistral:large')).toThrow(
      /unknown provider "mistral".*anthropic.*openai.*google.*xai/i,
    );
  });

  it('throws on a spec with no model segment', () => {
    expect(() => defaultModel('anthropic')).toThrow(/provider:model/);
  });

  it('throws on a spec with an empty model segment', () => {
    expect(() => defaultModel('anthropic:')).toThrow(/provider:model/);
  });

  it('throws on a spec with an empty provider segment (leading colon)', () => {
    expect(() => defaultModel(':claude-sonnet-4-6')).toThrow(/provider:model/);
  });

  it('trims surrounding whitespace — trailing spaces in .env values are common', () => {
    vi.stubEnv('AI_MODEL', ' openai:gpt-5.1 ');
    expect(defaultModel().modelId).toBe('gpt-5.1');
  });

  it('throws on internal whitespace instead of constructing a wrong model id', () => {
    // "anthropic: claude-…" would otherwise build modelId " claude-…" and
    // fail only as a request-time 404 with an invisible-whitespace id.
    expect(() => defaultModel('anthropic: claude-sonnet-4-6')).toThrow(/whitespace/);
    expect(() => defaultModel('open ai:gpt-5.1')).toThrow(/whitespace/);
    expect(() => defaultModel('anthropic:\tclaude-sonnet-4-6')).toThrow(/whitespace/);
  });

  it('throws on invisible non-printable characters, escaping them in the message', () => {
    // Zero-width space (U+200B) survives /\s/ AND .trim() — a model id
    // copy-pasted from rendered docs would look character-for-character
    // correct in the eventual 404. The guard must reject it and the error
    // must make the invisible character visible.
    expect(() => defaultModel('anthropic:claude\u200b-sonnet-4-6')).toThrow(/\\u200b/);
    expect(() => defaultModel('anthropic:\u00a0claude-sonnet-4-6')).toThrow(/\\u00a0/);
  });

  it('rejects invisibles in the PROVIDER segment too, not just the model segment', () => {
    expect(() => defaultModel('anthro\u200bpic:claude-sonnet-4-6')).toThrow(/\\u200b/);
  });

  it('escapes invisibles in the FORMAT error too \u2014 a ZWSP-only spec must not render as got ""', () => {
    // U+200B survives .trim(), so a ZWSP-only spec does NOT fall back to the
    // default; it has no colon and hits the malformed-spec branch. Without
    // escaping there, the error renders as `got ""` \u2014 maximally confusing,
    // because an actually-empty spec falls back and never produces it.
    expect(() => defaultModel('\u200b')).toThrow(/\\u200b/);
  });

  it('an NBSP-only spec falls back to the default \u2014 NBSP IS stripped by .trim()', () => {
    // Companion to the ZWSP case: the two invisibles behave differently by
    // design (trim strips Unicode whitespace, which includes NBSP but not ZWSP).
    expect(defaultModel('\u00a0').modelId).toBe('claude-sonnet-4-6');
  });

  it('treats a whitespace-only spec as unset, consistent with the empty string', () => {
    // AI_MODEL=" " in a quoted .env line must behave like AI_MODEL="" (fall
    // back to the default), not crash at startup with a confusing `got ""`.
    vi.stubEnv('AI_MODEL', '   ');
    expect(defaultModel().modelId).toBe('claude-sonnet-4-6');
    expect(defaultModel(' \t ').modelId).toBe('claude-sonnet-4-6');
  });

  it('an explicit empty-string spec falls back to the DEFAULT, not the env var', () => {
    // Pins the `spec || DEFAULT_SPEC` precedence: passing '' means "use the
    // default", it does NOT re-read AI_MODEL. A refactor to `spec ?? env`
    // would silently change this for `defaultModel(config.model ?? '')` callers.
    vi.stubEnv('AI_MODEL', 'openai:gpt-5.1');
    expect(defaultModel('').modelId).toBe('claude-sonnet-4-6');
  });
});
