import { ConciergeError } from '@concierge/sdk';
import { generateText, type LanguageModel, stepCountIs, type ToolSet } from 'ai';
import { sanitizeError, sanitizeMessage } from '../sanitize.ts';
import type { AgentState, PhaseOutcome, Plan } from '../types.ts';
import { buildPlanUserMessage, MAX_GOAL_CHARS, PLAN_SYSTEM_PROMPT_PREFIX } from './planPrompt.ts';
import { type LlmPlan, planSchema } from './planSchema.ts';
import { filterToPlanTools } from './planTools.ts';

const PLAN_STEP_CAP = 3;
const RAW_OUTPUT_MAX = 1000;

export interface RunPlanInputs {
  readonly model: LanguageModel;
  readonly tools: ToolSet;
}

export interface RunPlanOptions {
  readonly systemPromptPrefix?: string;
  readonly maxOutputTokens?: number;
  /** Caller's abort signal (e.g. from the tick orchestrator's per-phase AbortController). */
  readonly abortSignal?: AbortSignal;
}

/**
 * Capture the LAST fenced JSON block in the output. Tool-call echoes often
 * precede the final plan; if we captured the first fence, the tool echo
 * would parse and the real plan would be silently dropped. Newlines around
 * the fence delimiters are OPTIONAL to handle tight emissions.
 */
function unwrapJson(raw: string): string {
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  if (fences.length > 0) {
    const last = fences[fences.length - 1];
    if (last?.[1]) return last[1].trim();
  }
  return raw.trim();
}

const FORBIDDEN_TOP_KEYS = ['__proto__', 'constructor', 'prototype'];

function rejectPrototypePollution(json: string): unknown {
  // Use a reviver to strip forbidden keys before they can land on the result
  // object. JSON.parse keeps `__proto__` as an own property; downstream
  // spreads/Object.assign would then pollute the prototype chain.
  return JSON.parse(json, (k, v) => (FORBIDDEN_TOP_KEYS.includes(k) ? undefined : v));
}

/**
 * Plan-phase runner. Distinguishes error classes:
 *   - LlmCallFailed     — SDK throw OR finishReason='error' (retryable)
 *   - PlanIncomplete    — empty text / 'length' / 'tool-calls' / 'content-filter' / 'other'
 *                         (resource/budget/policy exhaustion — NOT hallucination)
 *   - PlanSchemaViolation — malformed JSON / failed Zod (deterministic, no-retry)
 */
export async function runPlan(
  state: AgentState,
  inputs: RunPlanInputs,
  options: RunPlanOptions = {},
): Promise<PhaseOutcome<Plan>> {
  if (state.goal.length > MAX_GOAL_CHARS) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] runPlan: state.goal exceeds ${MAX_GOAL_CHARS} chars (got ${state.goal.length}). Cap upstream.`,
    );
  }

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
      ...(options.abortSignal !== undefined && { abortSignal: options.abortSignal }),
    });
  } catch (err) {
    throw new ConciergeError(
      'LlmCallFailed',
      `[@concierge/runtime] runPlan: LLM call failed: ${sanitizeError(err).message}`,
      sanitizeError(err),
    );
  }

  // finishReason='error' is a SDK-resolved failure (resolved, not thrown) —
  // operationally equivalent to a thrown LlmCallFailed, NOT a plan-quality issue.
  if (result.finishReason === 'error') {
    throw new ConciergeError(
      'LlmCallFailed',
      `[@concierge/runtime] runPlan: model returned finishReason='error'.`,
      undefined,
      { finishReason: 'error' },
    );
  }

  const text = (result.text ?? '').trim();
  // Any non-'stop' finishReason means the model didn't produce a final JSON
  // output (truncated, step-cap, safety filter, etc.) — distinguish from
  // hallucination via PlanIncomplete + finishReason in metadata for dashboards.
  if (text === '' || result.finishReason !== 'stop') {
    throw new ConciergeError(
      'PlanIncomplete',
      `[@concierge/runtime] runPlan: no usable final text (finishReason='${result.finishReason}', textLen=${text.length}).`,
      undefined,
      {
        finishReason: result.finishReason,
        textLength: text.length,
        textWasUndefined: result.text === undefined,
      },
    );
  }

  const raw = unwrapJson(text);
  const safeRawSlice = sanitizeMessage(raw.slice(0, RAW_OUTPUT_MAX));

  let parsedJson: unknown;
  try {
    parsedJson = rejectPrototypePollution(raw);
  } catch (jsonErr) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output was not valid JSON.`,
      sanitizeError(jsonErr),
      { rawOutput: safeRawSlice, rootShape: 'invalid-json' },
    );
  }
  // Reject scalar/null/array roots — the schema requires an object but we
  // want operators to see this as distinct from "object with wrong shape".
  if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output root is not a plain object.`,
      undefined,
      { rawOutput: safeRawSlice, rootShape: parsedJson === null ? 'null' : typeof parsedJson },
    );
  }

  const parsed = planSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ConciergeError(
      'PlanSchemaViolation',
      `[@concierge/runtime] runPlan: model output failed Zod validation.`,
      undefined,
      { rawOutput: safeRawSlice, zodIssues: parsed.error.issues, rootShape: 'object' },
    );
  }

  const llmPlan: LlmPlan = parsed.data;
  const plan: Plan = {
    intent: llmPlan.intent,
    providerCalls: [...llmPlan.suggestedActions],
  };
  return { kind: 'continue', data: plan };
}
