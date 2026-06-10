# @concierge/agentkit

Coinbase AgentKit adapter for the framework-agnostic
[`@concierge/tools`](../tools) registry, built on AgentKit's
**`customActionProvider` escape hatch** — not the documented
`@CreateAction` decorator path. No class hierarchy, no decorator syntax, no
`reflect-metadata` import, no `experimentalDecorators` in your tsconfig.

```ts
import { AgentKit } from '@coinbase/agentkit';
import { getConciergeActionProvider } from '@concierge/agentkit';

// Any `(agent) => ConciergeTool[]` factory works — the @concierge provider
// packages each export one (aave, dex, susde, usdy, meth, lifi, erc8004):
const provider = getConciergeActionProvider({ chainId: 5000 }, [aaveTools, dexTools]);

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [provider],
});
```

Omitting the factories yields a provider with zero actions; registry
validation errors (duplicate tool names, schema violations) propagate
unchanged. Action results are stringified with `bigintSafeStringify`
(AgentKit's `Action.invoke` contract is `Promise<string>`, and provider tools
return wei-scale bigints that bare `JSON.stringify` throws on). Tool
rejections pass through by identity; serialization failures rethrow with the
tool's name attached and the original error as `cause`.

## AgentKit behaviors you should know (verified against 0.10.4)

- **One provider per process — enforced.** AgentKit registers custom-action
  metadata on the shared `CustomActionProvider` class and resolves
  `getActions()` from it at call time. A second registration silently rebinds
  dispatch for overlapping tool names (last wins) **and** silently merges
  disjoint actions into every provider's `getActions()` (union leakage) —
  both dispatch actions against the wrong agent context, so
  `getConciergeActionProvider` **throws** if custom actions already exist in
  the process. Raw `customActionProvider` calls elsewhere bypass this guard.
- **Action names are prefixed.** AgentKit stamps `${ClassName}_${name}` on
  every custom action, so `proposeAction` surfaces to the model as
  `CustomActionProvider_proposeAction`.
- **Telemetry can crash your process.** Every action invocation fires
  AgentKit's own un-awaited `fetch` to `cca-lite.coinbase.com`, with no
  rejection handler and no off-switch upstream. On Node >= 22 (this package's
  engine floor) an unreachable endpoint — air-gapped or egress-filtered
  deployments — surfaces as an **unhandled rejection that terminates the
  process** on every action invocation, after the tool itself already ran.
  Allow that egress, intercept `fetch`, or install a targeted
  `unhandledRejection` handler; stub `fetch` in tests.
- **Actions run in the agent's chain context, not the wallet's.** Chain
  gating (`supportsNetwork`) runs once at registration against
  `agent.chainId`; the AgentKit `walletProvider`'s network is never consulted
  (our closures are deliberately unary), and upstream hardcodes custom
  providers' `supportsNetwork` to `true` for every network.
- **`graphql` peer gap.** `@coinbase/agentkit`'s barrel eagerly imports
  `graphql-request`, which peers on `graphql` without AgentKit declaring it.
  Under pnpm with `auto-install-peers=false` you must install `graphql`
  yourself or the import throws `Cannot find module 'graphql'`.

## Validation semantics

AgentKit's wrapper calls the tool's own zod `inputSchema.parse(args)` before
delegating, so `ConciergeTool.invoke` receives the **parsed** value (defaults
applied, unknown keys stripped) — the same invariant as every other Concierge
adapter. AgentKit **core** only ever touches `.parse`, which is why zod-4
schemas work inside zod-3-era AgentKit; the cast lives in
`getConciergeActionProvider`, scoped to the `schema` field, and is pinned by
tests. **Scope caveat:** bridge packages that convert `action.schema` to JSON
Schema with zod-3 tooling (e.g. AgentKit's framework extensions) are NOT
verified with zod-4 schemas and may silently advertise an empty parameters
schema — wire the provider into `AgentKit.from(...)` and drive the model loop
yourself. `outputSchema` is **not** enforced on return values — AgentKit's
Action contract has no return-shape slot; output validation belongs to the
tool.

`toAgentKitAction(tool)` is exported for composing individual tools into your
own `customActionProvider` array (note that this path bypasses the
one-provider-per-process guard, and the returned `invoke` is pre-validation —
only call it through AgentKit). It throws a `TypeError` on
`.transform()`/`.pipe()` input schemas (downstream action→model bridges
convert the schema to JSON Schema, where a pipe may advertise its output
segment) and on non-object schemas.
