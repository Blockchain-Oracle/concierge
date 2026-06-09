# @concierge/vercel-ai

Vercel AI SDK v6 adapter for `@concierge/tools`. Converts the
framework-agnostic Concierge registry into a `ToolSet` ready for
`streamText({ tools })`, with `outputSchema` passed through so
`InferUITools` and `tool-${name}` UI parts stay fully typed.

## Quickstart

```ts
import { getVercelAITools } from '@concierge/vercel-ai';
import { streamText } from 'ai';

const result = streamText({
  model,
  tools: getVercelAITools(agent, [aaveTools /* …provider factories */]),
  prompt: 'Rebalance my portfolio toward yield.',
});
```

`getVercelAITools(agent, providerToolFactories?)` mirrors
`createConciergeTools` exactly: factories are composed, network-incompatible
tools are filtered for `agent.chainId`, and omitting the factories yields an
empty `ToolSet`. Seeing zero tools? Check that you passed the factories and
that `agent.chainId` matches the networks your tools support.

Aborting `streamText` does not cancel an in-flight tool call —
`ConciergeTool.invoke` takes no abort signal, so a started execution (e.g.
an on-chain transaction) runs to completion.

For per-tool type inference (e.g. `InferToolOutput`), convert a
concretely-typed definition directly with `toVercelAITool(t)` — the registry
erases generics at its boundary, the per-tool converter preserves them.

`ai` is a peer dependency (`^6.0.0`); bring your own model — any `ai` v6
`LanguageModel` works (model-agnostic per ADR-016).
