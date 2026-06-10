# @concierge/langchain

LangChain JS adapter for `@concierge/tools`. Converts the framework-agnostic
Concierge registry into `StructuredToolInterface[]` ready for
`model.bindTools(tools)` or any LangChain agent toolset.

## Quickstart

```ts
import { getLangChainTools } from '@concierge/langchain';

const tools = getLangChainTools(agent, [aaveTools /* …provider factories */]);
const bound = model.bindTools(tools);
```

`getLangChainTools(agent, providerToolFactories?)` mirrors
`createConciergeTools` exactly: factories are composed, network-incompatible
tools are filtered for `agent.chainId`, and omitting the factories yields an
empty array. Seeing zero tools? Check that you passed the factories and that
`agent.chainId` matches the networks your tools support.

Tool outputs are stringified (bigint-safe: wei amounts become decimal
strings) so `ToolMessage` content is a deterministic string under the
adapter's control — LangChain v1 would otherwise coerce objects itself.
Parse the string if you need the structured value. Inputs are validated
against the original Concierge Zod `inputSchema` (passed through by
reference) before `invoke` runs.

Cancelling a LangChain run does not cancel an in-flight tool call —
`ConciergeTool.invoke` takes no abort signal, so a started execution (e.g.
an on-chain transaction) runs to completion.

`@langchain/core` is a peer dependency (`^1.1.0`); bring your own model —
any LangChain chat model with tool-calling support works.
