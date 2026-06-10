// Coinbase AgentKit adapter for the framework-agnostic @concierge/tools
// registry (ADR-014), via the `customActionProvider` ESCAPE HATCH — never
// AgentKit's CreateAction decorator path. That keeps OUR src free of
// decorator syntax, metadata-reflection imports, and `experimentalDecorators`;
// AgentKit self-loads its reflection polyfill inside its own actionDecorator
// module. (The story's anti-regression greps for the literal decorator and
// polyfill import strings — keep them out of this package's src, comments
// included.)
//
// Outputs are stringified via bigintSafeStringify because AgentKit's
// `Action.invoke` contract is `Promise<string>`: bare JSON.stringify throws
// on the wei-scale bigints provider tools return, and handing back a raw
// object would rely on downstream coercion ("[object Object]").

import {
  ACTION_DECORATOR_KEY,
  CustomActionProvider,
  customActionProvider,
  type WalletProvider,
} from '@coinbase/agentkit';
import {
  bigintSafeStringify,
  type ConciergeAgentLike,
  type ConciergeTool,
  createConciergeTools,
  isZodObject,
  isZodPipe,
  type ProviderToolFactory,
} from '@concierge/tools';
import type { z } from 'zod';

/**
 * The options-array branch of `customActionProvider`'s parameter, extracted
 * via `Parameters` because AgentKit does not export its
 * CustomActionProviderOptions type (`export {}` in its d.ts).
 */
type AgentKitActionOptions = Extract<
  Parameters<typeof customActionProvider<WalletProvider>>[0],
  readonly unknown[]
>;

/**
 * AgentKit's `schema` slot, typed against its bundled zod 3 — the ONLY field
 * of the options shape a zod-4 schema cannot satisfy structurally.
 */
type AgentKitSchema = AgentKitActionOptions[number]['schema'];

/**
 * One entry of the `customActionProvider` options array, typed with OUR
 * zod-4 object schema (`toAgentKitAction`'s guards prove the `z.object`
 * narrowing). AgentKit's own option type annotates `schema` with its bundled
 * zod 3, so this interface is the honest shape we build; the per-field cast
 * in `getConciergeActionProvider` is the single boundary where the two zod
 * majors meet (see the comment there).
 *
 * `invoke` is PRE-validation: in the intended composition AgentKit's wrapper
 * calls `schema.parse(args)` before delegating, but calling `invoke`
 * directly hands RAW args to `ConciergeTool.invoke` — only invoke it through
 * AgentKit (or parse with `schema` yourself first).
 */
export interface ConciergeAgentKitAction {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  invoke: (args: unknown) => Promise<string>;
}

/**
 * Convert one ConciergeTool into a `customActionProvider` action. The
 * Concierge `inputSchema` passes through BY REFERENCE, and AgentKit's
 * wrapper calls `schema.parse(args)` before delegating — `invoke` receives
 * the PARSED value (defaults applied, unknown keys stripped), the same
 * invariant every other Concierge adapter upholds. Only `.parse` is touched
 * at runtime, which is why a zod-4 schema works inside zod-3-era AgentKit.
 *
 * The returned `invoke` is deliberately UNARY: AgentKit decides whether to
 * inject a WalletProvider by checking `invoke.length === 2`, so a binary
 * closure would silently shift the model's arguments out of position.
 *
 * Throws a `TypeError` on `.transform()`/`.pipe()` schemas: AgentKit core
 * only parses, but downstream action→model bridges convert `schema` to JSON
 * Schema, where a pipe MAY advertise its OUTPUT segment (bridge-dependent) —
 * a shape that may not match what `parse()` accepts (the openai/langchain
 * siblings reject the same trap). Non-object schemas are rejected for the
 * same registry invariant `createConciergeTools` enforces.
 *
 * Tool rejections pass through untouched, by identity. Serialization
 * failures (non-serializable return values) rethrow with the tool's name
 * attached and the original error as `cause`.
 */
export function toAgentKitAction(t: ConciergeTool): ConciergeAgentKitAction {
  // Validate and ship the SAME reference: the guard-narrowed local is what
  // gets returned, so a getter-backed `inputSchema` implementation cannot
  // hand AgentKit a different schema than the one validated here.
  const inputSchema = t.inputSchema;
  if (isZodPipe(inputSchema)) {
    throw new TypeError(
      `Tool "${t.name}" inputSchema uses .transform() or .pipe(); perform normalization inside invoke() instead — AgentKit consumers convert the advertised schema to JSON Schema, which may ship the pipe's output shape.`,
    );
  }
  if (!isZodObject(inputSchema)) {
    throw new TypeError(
      `Tool "${t.name}" has a non-object inputSchema; ConciergeTool requires a Zod object schema (z.object({ ... })).`,
    );
  }
  return {
    name: t.name,
    description: t.description,
    schema: inputSchema,
    invoke: async (args: unknown) => {
      const result = await t.invoke(args);
      try {
        return bigintSafeStringify(result);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `[@concierge/agentkit] tool "${t.name}" returned a non-serializable result: ${detail}`,
          { cause },
        );
      }
    },
  };
}

/**
 * Build an AgentKit `ActionProvider` from the Concierge registry, ready for
 * `AgentKit.from({ walletProvider, actionProviders: [provider] })`. Mirrors
 * `createConciergeTools(agent, providerToolFactories)`: omitting the
 * factories yields a provider with zero actions, and registry validation
 * errors (duplicate names, schema violations) propagate unchanged.
 *
 * ONE provider per process — ENFORCED. AgentKit 0.10.x stores custom-action
 * metadata on the shared CustomActionProvider class and `getActions`
 * resolves from it AT CALL TIME, so a second registration either silently
 * rebinds dispatch for overlapping tool names (last wins) or silently merges
 * disjoint actions into EVERY provider's `getActions()` (union leakage).
 * Both dispatch actions against the wrong agent context, so this factory
 * THROWS when custom actions are already registered in the process. Raw
 * `customActionProvider` calls elsewhere bypass this guard — the hazard is
 * upstream's registration model, not this adapter's.
 *
 * Two more AgentKit behaviors consumers must know (verified against 0.10.4):
 *
 * - Action names surface PREFIXED as `CustomActionProvider_<toolName>` —
 *   AgentKit's CreateAction stamps `${ClassName}_${name}` on every custom
 *   action, and models address tools by the full prefixed name.
 * - Every action invocation fires AgentKit's own un-awaited telemetry fetch
 *   to `cca-lite.coinbase.com`, with NO rejection handler upstream. On
 *   Node >= 22 (this package's engine floor) an unreachable endpoint —
 *   air-gapped or egress-filtered deployments — therefore CRASHES the
 *   process via unhandled rejection on every action invocation, with a
 *   stack pointing into Coinbase analytics code. Allow that egress,
 *   intercept `fetch`, or install a targeted unhandledRejection handler;
 *   stub `fetch` in tests.
 *
 * Validation scope: AgentKit CORE only calls `schema.parse` (verified
 * against the 0.10.4 dist, pinned by tests), which is why zod-4 schemas
 * work inside zod-3-era AgentKit. Bridge packages that JSON-Schema-convert
 * `action.schema` with zod-3 tooling are NOT verified with zod-4 schemas
 * and may silently advertise an empty parameters schema — wire the provider
 * into `AgentKit.from(...)` and drive the model loop yourself.
 *
 * `outputSchema` is deliberately NOT enforced on the return value (same
 * policy as the langchain sibling): AgentKit's Action contract has no
 * return-shape slot — output validation belongs to the tool. Cancelling an
 * AgentKit run does NOT cancel an in-flight tool call — `ConciergeTool.invoke`
 * takes no abort signal, so a started execution runs to completion. Chain
 * gating runs ONCE at registration against `agent.chainId`; the AgentKit
 * `walletProvider`'s network is never consulted (closures are unary), and
 * upstream hardcodes custom providers' `supportsNetwork` to true.
 */
export function getConciergeActionProvider(
  agent: ConciergeAgentLike,
  providerToolFactories?: ReadonlyArray<ProviderToolFactory>,
): CustomActionProvider<WalletProvider> {
  const actions = createConciergeTools(agent, providerToolFactories).map(toAgentKitAction);
  // Registration-time guard for upstream's shared-class registry (keyed by
  // UN-prefixed tool name). Without it a second provider silently
  // dispatches actions against the WRONG agent — in a DeFi agent that
  // executes transactions, a funds-level failure mode with zero signal.
  const registered: ReadonlyMap<string, unknown> | undefined = Reflect.getMetadata(
    ACTION_DECORATOR_KEY,
    CustomActionProvider,
  );
  if (registered && registered.size > 0) {
    const overlap = actions.filter((a) => registered.has(a.name)).map((a) => a.name);
    const consequence =
      overlap.length > 0
        ? `would silently rebind dispatch for: ${overlap.join(', ')}`
        : `its actions would silently merge into this provider's getActions()`;
    throw new Error(
      `[@concierge/agentkit] custom actions are already registered in this process and ${consequence}. AgentKit 0.10.x stores custom-action metadata on the shared CustomActionProvider class — create ONE provider per process.`,
    );
  }
  // Single cross-library type boundary, scoped to the ONE incompatible
  // field: AgentKit's option type annotates `schema` with its bundled zod 3,
  // which a zod-4 schema cannot satisfy structurally. Runtime only ever
  // calls `schema.parse` (verified against the 0.10.4 dist and pinned by
  // this package's tests), so the cast is type-level reconciliation, not a
  // behavior change. `satisfies` keeps `name`/`description`/`invoke`
  // structurally checked, so an upstream option-shape change breaks the
  // build instead of breaking at runtime.
  const options = actions.map((a) => ({
    ...a,
    schema: a.schema as unknown as AgentKitSchema,
  })) satisfies AgentKitActionOptions;
  return customActionProvider<WalletProvider>(options);
}
