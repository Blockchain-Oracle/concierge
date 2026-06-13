import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { xai } from '@ai-sdk/xai';

const DEFAULT_SPEC = 'anthropic:claude-sonnet-4-6';

// Single source of truth: switch cases AND the unknown-provider error message
// both derive from this list, so they cannot drift apart. Mirrors the
// CONCIERGE_ERROR_TYPES pattern.
// Note: apps/worker uses Claude Agent SDK and is Anthropic-only internally;
// this helper is for SDK consumers who may plug in any provider.
/**
 * The frozen list of provider keys `defaultModel()` accepts. Exported so SDK
 * consumers can drive UIs (provider dropdowns) and validate `AI_MODEL`-style
 * input against the SAME source of truth the runtime switch uses.
 */
export const SUPPORTED_PROVIDERS = Object.freeze(['anthropic', 'openai', 'google', 'xai'] as const);
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Env-auto-detect model helper per ADR-016: `AI_MODEL="provider:model"`
 * selects the model without touching code; unset (or empty) falls back to
 * `anthropic:claude-sonnet-4-6`. An explicit `spec` argument beats the env
 * var. Supported providers: `anthropic`, `openai`, `google`, `xai`.
 *
 * API keys are NOT read here — each @ai-sdk provider factory reads its key
 * (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` /
 * `XAI_API_KEY`) lazily at request time, so constructing a model is free and
 * a missing key surfaces on the first call, not here.
 *
 * The spec splits on the FIRST colon only: model ids themselves may contain
 * colons (OpenAI fine-tune ids like `ft:gpt-5.1:org:custom`). Surrounding
 * whitespace is trimmed and a whitespace-only spec is treated as unset
 * (trailing spaces / quoted-blank lines in `.env` values are common); any
 * INTERNAL character outside printable ASCII throws, with non-printables
 * escaped in the message — see `NON_PRINTABLE_ASCII` below for the threat
 * model. Malformed specs throw a plain `Error` (not `ConciergeError`): a bad
 * spec is programmer/config misuse at construction time, not one of
 * ADR-019's runtime DeFi failures.
 *
 * Returns `LanguageModelV3` — the interface the installed @ai-sdk 3.x
 * provider factories actually ship (ADR-016 sketches `LanguageModelV2`;
 * SDK-DX-STUDY §A says to pin to whatever interface is active at story
 * time, and `ai@6` accepts both).
 */
// Everything outside printable ASCII (0x21-0x7E) is hostile inside a spec:
// regular whitespace, but also U+200B-class invisibles that survive `/\s/`
// AND `.trim()` — a zero-width char copy-pasted from rendered docs would
// otherwise reach the provider inside a model id that LOOKS character-for-
// character correct and fail only as a request-time 404.
const NON_PRINTABLE_ASCII = /[^\x21-\x7E]/;

/**
 * Escapes non-printables as `\uXXXX` so they are visible in error messages.
 * Deliberately one char wider than the guard (starts at 0x20, not 0x21):
 * a regular space is INVALID in a spec but perfectly readable in an error,
 * so it stays literal here.
 * Uses `codePointAt` (not `charCodeAt`) so astral-plane chars (e.g. emoji)
 * produce one escape entry instead of two surrogate halves.
 */
function escapeInvisibles(s: string): string {
  return [...s]
    .map((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= 0x20 && cp <= 0x7e ? c : `\\u${cp.toString(16).padStart(4, '0')}`;
    })
    .join('');
}

function isSupportedProvider(p: string): p is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(p);
}

export function defaultModel(spec = process.env['AI_MODEL']): LanguageModelV3 {
  // Trim BEFORE the fallback check so a whitespace-only spec (quoted-blank
  // .env line) behaves like the empty string: fall back, don't crash.
  const normalized = (spec ?? '').trim() || DEFAULT_SPEC;
  const splitAt = normalized.indexOf(':');
  if (splitAt <= 0 || splitAt === normalized.length - 1) {
    // escapeInvisibles here too: a ZWSP-only spec survives .trim(), has no
    // colon, and lands in THIS branch — unescaped it renders as `got ""`,
    // while an actually-empty spec falls back and never produces this error.
    throw new Error(
      `[@concierge/sdk] defaultModel: expected a "provider:model" spec (e.g. "anthropic:claude-sonnet-4-6"), got "${escapeInvisibles(normalized)}".`,
    );
  }
  const provider = normalized.slice(0, splitAt);
  const model = normalized.slice(splitAt + 1);
  if (NON_PRINTABLE_ASCII.test(provider) || NON_PRINTABLE_ASCII.test(model)) {
    throw new Error(
      `[@concierge/sdk] defaultModel: "provider:model" spec contains whitespace or non-printable characters — got "${escapeInvisibles(normalized)}". Check AI_MODEL for stray or invisible characters.`,
    );
  }
  if (!isSupportedProvider(provider)) {
    throw new Error(
      `[@concierge/sdk] defaultModel: unknown provider "${provider}" — expected one of: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    );
  }
  switch (provider) {
    case 'anthropic':
      return anthropic(model);
    case 'openai':
      return openai(model);
    case 'google':
      return google(model);
    case 'xai':
      return xai(model);
    default: {
      // Round-2 (test-analyzer rating 9): TS exhaustiveness check — if a
      // future PR adds a provider to SUPPORTED_PROVIDERS but forgets the
      // switch case, this line fails to compile. Belt-and-suspenders with
      // the runtime isSupportedProvider guard above.
      const _exhaustive: never = provider;
      throw new Error(`unreachable: ${String(_exhaustive)}`);
    }
  }
}
