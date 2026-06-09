# @concierge/tools

Framework-agnostic Concierge tool registry. The single source of truth for
the `ConciergeTool` interface — every adapter (Vercel AI SDK, OpenAI,
LangChain, Coinbase AgentKit, MCP server, React UI) consumes the same shape,
with one `inputSchema` + `outputSchema` definition feeding all surfaces.

## Quickstart

```ts
import { createConciergeTools, tool } from '@concierge/tools';
import { z } from 'zod';

// 1. Define a tool — `tool()` is an identity helper that preserves type inference.
const supply = tool({
  name: 'supply',
  description: 'Supply USDC to Aave V3',
  inputSchema: z.object({ amount: z.number() }),
  outputSchema: z.object({ txHash: z.string() }),
  invoke: async ({ amount }) => ({ txHash: `0x${amount.toString(16)}` }),
  supportsNetwork: (id) => id === 5000, // Mantle Mainnet only
});

// 2. Provider packages export a `tools(agent)` factory that returns ConciergeTool[].
const aaveTools = () => [supply];

// 3. Aggregate. Network-incompatible tools are filtered out automatically.
const tools = createConciergeTools({ chainId: 5000 }, [aaveTools]);
```

## Adapter pattern

Each adapter package wraps `ConciergeTool[]` into the framework's native shape.
See `@concierge/vercel-ai`, `@concierge/openai`, `@concierge/langchain`,
`@concierge/agentkit`, `@concierge/mcp` for ~30-LOC reference implementations.

## Card schemas

`/serializable` exports the four canonical card schemas the MCP server +
React UI parse-then-render against (per ADR-017):

```ts
import {
  SerializableProposalCardSchema,
  SerializableTickCardSchema,
  SerializablePortfolioCardSchema,
  SerializableReputationCardSchema,
} from '@concierge/tools/serializable';
```

A tool whose job is to emit one of these cards SHOULD use the schema as its
`outputSchema` so the MCP `structuredContent` round-trip is type-safe.
