# @concierge/sdk

Meta package for the Concierge core: one install re-exporting
[`@concierge/tools`](../tools) (the framework-agnostic tool registry) +
[`@concierge/vercel-ai`](../vercel-ai) (the Vercel AI SDK adapter) + the
SDK's own `defaultModel()` / `ConciergeRegistry` / `ConciergeError`.
Pure ESM, Node ≥ 22 (ADR-018).

```bash
pnpm add @concierge/sdk                        # core
pnpm add @concierge/langchain @concierge/sdk   # LangChain consumers
pnpm add @concierge/openai @concierge/sdk      # OpenAI / Anthropic raw tool-use
pnpm add @concierge/agentkit @concierge/sdk    # Coinbase AgentKit consumers
```

## Quickstart (today)

```ts
import { streamText } from 'ai';
import { ConciergeRegistry, defaultModel, getVercelAITools } from '@concierge/sdk';

const registry = ConciergeRegistry.mainnet(); // bundled, frozen Mantle addresses

const result = streamText({
  model: defaultModel(), // env auto-detect: AI_MODEL || anthropic:claude-sonnet-4-6
  tools: getVercelAITools(registry, [
    /* @concierge provider tool factories (aave, dex, susde, ...) */
  ]),
  prompt: 'What is my Aave health factor?',
});
```

> **The agent runtime is not in this package yet.** `createConcierge()` /
> `Concierge` / `concierge.tick()` (the ADR-019 five-line quickstart) ship
> with `@concierge/agent` in Epic E5 and will be re-exported here when that
> package exists. This skeleton deliberately does NOT stub them — a fake
> runtime in the hot path is forbidden.

## `defaultModel()` — env auto-detect (ADR-016)

`defaultModel(spec?)` returns a Vercel AI SDK language model from a
`"provider:model"` spec — the explicit argument, else the `AI_MODEL` env
var, else `anthropic:claude-sonnet-4-6`.

- Providers: `anthropic`, `openai`, `google`, `xai`. Unknown provider or a
  malformed spec throws immediately with the expected shape in the message.
- **No API key is read at construction.** Each `@ai-sdk/*` factory reads its
  key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`
  / `XAI_API_KEY`) lazily at request time — a missing key surfaces on the
  first model call, not when `defaultModel()` runs.
- The spec splits on the **first** colon only, so model ids containing
  colons (OpenAI fine-tunes like `ft:gpt-5.1:org:custom`) pass through intact.
- Surrounding whitespace is trimmed and a whitespace-only spec falls back to
  the default (quoted-blank `.env` lines behave like unset); any **internal**
  character outside printable ASCII throws instead of constructing a model id
  that would only fail as a request-time 404 — including invisibles like
  U+200B that survive `.trim()`, which the error message escapes as `\u200b`
  so you can actually see them.
- Returns `LanguageModelV3` — the interface the installed `@ai-sdk/*` 3.x
  providers actually ship (`ai@6` accepts it everywhere a model is taken).
  ADR-016's sketch says `LanguageModelV2`; per SDK-DX-STUDY §A the pin
  follows whatever interface is active at story time.

## `ConciergeRegistry` — bundled Mantle addresses

`ConciergeRegistry.mainnet()` (chain 5000) / `ConciergeRegistry.sepolia()`
(chain 5003). The `addresses` field is the **same frozen object**
`@concierge/shared` exports — by reference, never a copy — so there is
exactly one source of truth and runtime mutation is impossible. Instances
implement `ConciergeAgentLike`, so a registry can be passed directly to
`createConciergeTools` or any adapter factory as the agent context.

Sepolia's non-ERC-8004 addresses are zero placeholders until story-192's
mock deploy lands. Two programmatic guards, so nothing depends on prose:

- **`registry.requireAddress(path)`** — resolves a dot-path (e.g.
  `'aave.pool'`) to a deployed address, throwing
  `ConciergeError('NetworkUnsupported')` for a zero-address placeholder
  instead of letting a provider `eth_call` `0x000…000` (opaque ABI-decode
  failure) or send funds there (burned). Prefer it over reading `addresses`
  directly whenever the address is about to be called or funded.
- **`SEPOLIA_PENDING_ADDRESS_SLOTS`** (re-exported from `@concierge/shared`,
  frozen) — the full list of pending paths, for consumers that want to
  enumerate or pre-check.

```ts
import { ConciergeRegistry, SEPOLIA_PENDING_ADDRESS_SLOTS } from '@concierge/sdk';

ConciergeRegistry.mainnet().requireAddress('aave.pool'); // 0x458F…1422
ConciergeRegistry.sepolia().requireAddress('aave.pool'); // throws NetworkUnsupported
```

## `ConciergeError` — typed errors (ADR-019)

One base class, `type` discriminator, optional `cause` pass-through:

```ts
try {
  /* ... */
} catch (err) {
  if (err instanceof ConciergeError && err.type === 'EModeNotEnabled') {
    // Aave's Pool.borrow() returns 0 SILENTLY for sUSDe outside E-Mode 1 —
    // the SDK surfaces that trap as a loud, typed error.
  }
}
```

Types: `EModeNotEnabled` · `InsufficientLiquidity` · `OracleUnavailable` ·
`AttestationFailed` · `UserRejected` · `NetworkUnsupported` · `RpcError` —
also exported at runtime as `CONCIERGE_ERROR_TYPES` (frozen), with an
`isConciergeErrorType(value)` narrowing helper for untyped inputs. The
constructor validates `type` against that list (loud `TypeError` for
plain-JS typos) and makes `type` non-writable after construction, and
`cause` keeps native `ErrorOptions` semantics: installed only when provided
(falsy-but-defined causes like `null` ARE installed), non-enumerable, so
`JSON.stringify(err)` never leaks a raw revert.

## What's re-exported

- From `@concierge/tools`: `tool()`, `createConciergeTools`,
  `bigintSafeStringify`, the serializable card schemas (`CARD_SCHEMAS`,
  `Serializable*CardSchema`, `safeParse*` helpers, `TICK_PHASE_VALUES`) and
  the core types (`ConciergeTool`, `ConciergeAgentLike`,
  `ProviderToolFactory`, `TickPhase`, `UICardId`).
- From `@concierge/vercel-ai`: `getVercelAITools`, `toVercelAITool`.
- Adapter-author utilities (`toJsonSchema`, zod guards) stay in
  `@concierge/tools` — import them from there directly.
