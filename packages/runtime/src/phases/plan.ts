import { MODEL_SONNET, routeModelForPhase } from '@concierge/llm';
import { ConciergeError } from '@concierge/sdk';
import { generateText, type LanguageModel, stepCountIs, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { AgentState, PhaseOutcome, Plan } from '../types.ts';
import { buildPlanUserMessage, PLAN_SYSTEM_PROMPT_PREFIX } from './planPrompt.ts';
import { type LlmPlan, planSchema } from './planSchema.ts';
import { assertNotBanned, filterToPlanTools } from './planTools.ts';

const PLAN_STEP_CAP = 3;

export interface RunPlanConfig {
  /**
   * LanguageModel from @ai-sdk — typically `defaultModel()` per ADR-016.
   * If omitted, caller MUST inject one; we don't auto-construct (the model
   * decision is per-tick + per-phase via routeModelForPhase).
   */
  readonly model: LanguageModel;
  /**
   * Read-only tool registry. `filterToPlanTools` strips execute tools
   * defensively; the caller's `ToolSet` may include the full ladder.
   */
  readonly tools: ToolSet;
  /** Optional override of the system-prompt prefix (testing / variants). */
  readonly systemPromptPrefix?: string;
  /** Optional max output tokens. Default 2048 — Plan JSON is small. */
  readonly maxOutputTokens?: number;
}

/** Strip Markdown fences if the model wrapped JSON in ```json ... ```. */
function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const inner = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    return inner.trim();
  }
  return trimmed;
}

/**
 * Plan-phase runner. Calls Claude Sonnet 4.6 with read-only tools, captures
 * the final text response, validates it against `planSchema`, and returns
 * a `Plan` shaped to the orchestrator's contract (story-62 types.ts).
 *
 * On Zod failure: throws `ConciergeError('PlanSchemaViolation')` carrying
 * the raw output + Zod issues in metadata. The orchestrator's `runPhase`
 * wraps this as a `{kind:'error', cause:'thrown'}` outcome — operators see
 * it as a hallucination signal, not a domain failure.
 *
 * Tool-call interception: any `tool-call` event for a BANNED tool name
 * triggers `assertNotBanned` (defense-in-depth; the registry shouldn't
 * surface execute tools at all but a custom factory could regress this).
 */
export async function runPlan(
  state: AgentState,
  config: RunPlanConfig,
): Promise<PhaseOutcome<Plan>> {
  // Phase-locked model — the LLM package's router is the single source of
  // truth. Bypass via per-call override is intentionally NOT supported here.
  const _phaseModel = routeModelForPhase('plan');
  if (_phaseModel !== MODEL_SONNET) {
    // Sanity guard: if the route table is mis-edited, fail loud.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] runPlan: routeModelForPhase('plan') returned '${_phaseModel}' — expected '${MODEL_SONNET}'. Check @concierge/llm route table.`,
    );
  }

  const readOnlyTools = filterToPlanTools(config.tools);

  const result = await generateText({
    model: config.model,
    tools: readOnlyTools,
    system: config.systemPromptPrefix ?? PLAN_SYSTEM_PROMPT_PREFIX,
    messages: [{ role: 'user', content: buildPlanUserMessage(state) }],
    stopWhen: stepCountIs(PLAN_STEP_CAP),
    maxOutputTokens: config.maxOutputTokens ?? 2048,
    // biome-ignore lint/suspicious/noExplicitAny: Vercel AI v6 toolCall typing varies; defense-in-depth runtime check
    onStepFinish: ({ toolCalls }: { toolCalls?: Array<{ toolName: string }> }) => {
      if (toolCalls) for (const tc of toolCalls) assertNotBanned(tc.toolName);
    },
  });

  // Parse final text → JSON → planSchema.
  const raw = unwrapJson(result.text);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (jsonErr) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output was not valid JSON.`,
      jsonErr,
      { rawOutput: raw.slice(0, 1000) },
    );
  }
  const parsed = planSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output failed Zod validation.`,
      undefined,
      {
        rawOutput: raw.slice(0, 1000),
        zodIssues: parsed.error.issues as unknown as readonly z.ZodIssue[],
      },
    );
  }

  // Map LlmPlan → orchestrator's Plan shape. The orchestrator's Plan carries
  // `intent: string` and `providerCalls`; we project ActionDescriptor[]
  // straight through.
  const llmPlan: LlmPlan = parsed.data;
  const plan: Plan = {
    intent: llmPlan.intent,
    providerCalls: llmPlan.suggestedActions.map((a) => ({
      provider: a.providerName,
      action: a.actionName,
      args: a.args,
    })),
  };
  return { kind: 'continue', data: plan };
}
