# @concierge/openai

Raw-shape OpenAI adapter for the framework-agnostic [`@concierge/tools`](../tools)
registry. Wraps **no SDK**: `getOpenAITools` returns the Chat Completions
wire-format tool array plus a `dispatch()` executor, so the same toolkit drives
the `openai` client **and** Anthropic Messages raw tool-use — one adapter, two
runtimes.

```ts
import { getOpenAITools } from '@concierge/openai';
import { aaveTools, dexTools } from '@concierge/providers'; // example factories

const toolkit = getOpenAITools({ chainId: 5000 }, [aaveTools, dexTools]);
```

## Quickstart — OpenAI Chat Completions

```ts
import OpenAI from 'openai';
import { bigintSafeStringify, getOpenAITools } from '@concierge/openai';

const client = new OpenAI();
const toolkit = getOpenAITools(agent, factories);

const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'user', content: 'Propose my next portfolio move.' },
];
const completion = await client.chat.completions.create({
  model: 'gpt-5.2',
  messages,
  tools: toolkit.tools, // assignable to ChatCompletionFunctionTool[]
});

// Handle EVERY tool call — parallel tool calls are the model's default, and
// the follow-up create() 400s unless each tool_call_id gets a tool message.
const reply = completion.choices[0]?.message;
if (reply?.tool_calls?.length) {
  messages.push(reply);
  for (const call of reply.tool_calls) {
    if (call.type !== 'function') continue;
    const result = await toolkit.dispatch(call.function.name, call.function.arguments);
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: bigintSafeStringify(result),
    });
  }
}
```

## Quickstart — Anthropic Messages (raw tool-use)

The Chat Completions `parameters` content **is** Anthropic's `input_schema` —
only the envelope keys differ:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { bigintSafeStringify, getOpenAITools } from '@concierge/openai';

const client = new Anthropic();
const toolkit = getOpenAITools(agent, factories);

const tools: Anthropic.Messages.Tool[] = toolkit.tools.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters, // carries the literal type: 'object'
}));

const message = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Propose my next portfolio move.' }],
  tools,
});

// A single assistant message can carry MULTIPLE tool_use blocks — answer
// every one, or the follow-up messages.create() rejects the conversation.
for (const block of message.content) {
  if (block.type !== 'tool_use') continue;
  const result = await toolkit.dispatch(block.name, block.input as object);
  // reply with { type: 'tool_result', tool_use_id: block.id, content: bigintSafeStringify(result) }
}
```

## dispatch semantics

- `args` accepts the **raw JSON string** from `tool_calls[].function.arguments`
  or an **already-parsed object** from Anthropic's `tool_use.input`.
- Input is validated with the tool's own `inputSchema` **before** `invoke`
  runs — defaults applied, unknown keys stripped, invalid input rejects with a
  `ZodError`. Malformed JSON rejects with `SyntaxError`; unknown tool names
  reject with an error listing the known tools. Nothing fails silently.
- `dispatch` returns the raw `invoke()` value. Serialize it for the tool-result
  message with the re-exported `bigintSafeStringify` — plain `JSON.stringify`
  **throws on the wei-scale bigints** Concierge tools emit.

## Gotchas

- **Zero tools?** Omitted factories AND an unsupported `chainId` both yield
  `tools: []` silently — check both before debugging the model.
- **No abort propagation.** Cancelling the model request does NOT cancel an
  in-flight tool call: `ConciergeTool.invoke` takes no abort signal, so a
  started execution (e.g. an on-chain transaction) runs to completion.
- **Not strict-mode ready.** OpenAI `strict: true` requires
  `additionalProperties: false` (emitted — fine) AND every property `required`
  — but `.optional()` properties are omitted from `required`, so schemas with
  optionals fail strict validation. Leave `strict` unset (the default).
- **`.transform()`/`.pipe()` input schemas throw at construction time** — the
  schema advertised to the model must match what `inputSchema.parse()`
  accepts. Normalize inside `invoke()` instead.
- **`.refine()`/`z.custom()` are invisible to the model.** Refinements are
  stripped from the emitted JSON Schema (they still validate at dispatch) and
  `z.custom()` emits an unconstrained `{}` — so the model can't see the
  constraint and will violate it. Put the rule in `.describe()` text too.
