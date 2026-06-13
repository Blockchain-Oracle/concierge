import { ConciergeError } from '@concierge/sdk';
import { generateText, type LanguageModel, stepCountIs, type ToolSet } from 'ai';
import { sanitizeError, sanitizeMessage } from '../sanitize.ts';
import type { AgentState, PhaseOutcome, Plan } from '../types.ts';
import { buildPlanUserMessage, PLAN_SYSTEM_PROMPT_PREFIX } from './planPrompt.ts';
import { type LlmPlan, planSchema } from './planSchema.ts';
import { filterToPlanTools } from './planTools.ts';

const PLAN_STEP_CAP = 3;
const RAW_OUTPUT_MAX = 1000;

export interface RunPlanInputs {
  /** LanguageModel from @ai-sdk — typically `defaultModel()` per ADR-016. */
  readonly model: LanguageModel;
  /** Tool registry; `filterToPlanTools` strips execute tools. */
  readonly tools: ToolSet;
}

export interface RunPlanOptions {
  readonly systemPromptPrefix?: string;
  readonly maxOutputTokens?: number;
}

/**
 * Extract JSON from LLM output that may be wrapped in Markdown fences,
 * optionally with preamble/trailing text. Captures the FIRST balanced
 * fenced block; falls back to the raw trimmed text. Models occasionally
 * emit `"Here is the plan:\n\`\`\`json\n{...}\n\`\`\`"` despite prompt
 * instructions — handle gracefully without silently mangling embedded
 * backticks inside JSON string fields.
 */
function unwrapJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fence?.[1]) return fence[1].trim();
  return raw.trim();
}

/**
 * Plan-phase runner. Distinguishes three error classes:
 *   - `LlmCallFailed`        — network/auth/rate-limit (retryable)
 *   - `PlanIncomplete`       — empty text / step-cap / length truncation
 *                              (resource exhaustion — NOT hallucination)
 *   - `PlanSchemaViolation`  — malformed JSON / failed Zod validation
 *                              (deterministic hallucination — no retry)
 *
 * Operators dashboard these separately. Without the split, every metric
 * for "agent reasoning quality" is poisoned by retryable infra errors.
 */
export async function runPlan(
  state: AgentState,
  inputs: RunPlanInputs,
  options: RunPlanOptions = {},
): Promise<PhaseOutcome<Plan>> {
  const readOnlyTools = filterToPlanTools(inputs.tools);

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: inputs.model,
      tools: readOnlyTools,
      system: options.systemPromptPrefix ?? PLAN_SYSTEM_PROMPT_PREFIX,
      messages: [{ role: 'user', content: buildPlanUserMessage(state) }],
      stopWhen: stepCountIs(PLAN_STEP_CAP),
      maxOutputTokens: options.maxOutputTokens ?? 2048,
    });
  } catch (err) {
    // SDK/provider error (HTTP 4xx/5xx, ECONNRESET, AbortError, etc).
    // Sanitize so Pimlico apikey / Bearer tokens don't reach Sentry.
    throw new ConciergeError(
      'LlmCallFailed',
      `[@concierge/runtime] runPlan: LLM call failed: ${sanitizeError(err).message}`,
      sanitizeError(err),
    );
  }

  // Distinguish "no usable output" from "hallucinated output". finishReason
  // values per Vercel AI SDK v6: 'stop' | 'length' | 'tool-calls' | 'error'
  // | 'other' | 'content-filter'. Only 'stop' with non-empty text is a
  // candidate for schema validation.
  const text = (result.text ?? '').trim();
  if (text === '' || result.finishReason === 'length' || result.finishReason === 'tool-calls') {
    throw new ConciergeError(
      'PlanIncomplete',
      `[@concierge/runtime] runPlan: model returned no usable final text (finishReason='${result.finishReason}', textLen=${text.length}).`,
      undefined,
      { finishReason: result.finishReason, textLength: text.length },
    );
  }

  const raw = unwrapJson(text);
  // Sanitize before sliced into metadata — a read tool that returned
  // sensitive data (apikey / Bearer token / RPC URL) may have been
  // echoed in the model's final text. Bound length to keep error payload
  // small for Sentry.
  const safeRawSlice = sanitizeMessage(raw.slice(0, RAW_OUTPUT_MAX));

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (jsonErr) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output was not valid JSON.`,
      sanitizeError(jsonErr),
      { rawOutput: safeRawSlice },
    );
  }
  const parsed = planSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output failed Zod validation.`,
      undefined,
      { rawOutput: safeRawSlice, zodIssues: parsed.error.issues },
    );
  }

  // LlmPlan field names match Plan.providerCalls shape — straight passthrough.
  const llmPlan: LlmPlan = parsed.data;
  const plan: Plan = {
    intent: llmPlan.intent,
    providerCalls: [...llmPlan.suggestedActions],
  };
  return { kind: 'continue', data: plan };
}
