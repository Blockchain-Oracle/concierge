import { randomUUID } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import type {
  OrchestratedPhase,
  PhaseOutcome,
  TickConfig,
  TickLogger,
  TickResult,
} from './types.ts';

const DEFAULT_LOCK_TTL_MS = 60_000;
const ABORT_MARGIN_MS = 5_000;
const URL_API_KEY_RE = /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"'<>]+/gi;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Default error sanitizer. Mirrors story-55's `sanitizeMessage` — strips
 * apikey/token URL params before the error message lands in logs or the
 * TickResult. Stories 63-67 will call Pimlico (URL has `?apikey=…`), so this
 * runs at every phase boundary, not just on RPC errors.
 *
 * Preserves the original `cause` chain so downstream observers (Sentry,
 * pino's err serializer) keep the stack trace and the (sanitized) inner
 * error's `.name` for class-based dispatch.
 */
function defaultSanitizeError(err: unknown): Error {
  if (err instanceof Error) {
    const sanitized = new Error(err.message.replace(URL_API_KEY_RE, '$1<redacted>'), {
      cause: err,
    });
    sanitized.name = err.name;
    return sanitized;
  }
  return new Error(String(err).replace(URL_API_KEY_RE, '$1<redacted>'));
}

/**
 * Tick orchestrator. Sequences the 5-phase agent run (decide is out-of-loop)
 * under a Redis NX lock. Phases are DI-injected so this module is unit-
 * testable without provider/LLM imports. Each phase receives an AbortSignal
 * that fires at `lockTtlMs - 5s` so long-running RPCs cancel cleanly before
 * the lock expires and another worker races in.
 */
export async function tick(config: TickConfig): Promise<TickResult> {
  if (!AGENT_ID_RE.test(config.agentId)) {
    // CWE-74 defense — agentId is interpolated into a Redis key. Reject
    // anything that could namespace-collide or contain control chars.
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] tick: agentId must match ${AGENT_ID_RE.source}.`,
    );
  }
  const ttlMs = config.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const lockKey = `lock:agent:${config.agentId}`;
  const log = config.logger ?? NOOP_LOGGER;
  const tickId = randomUUID();
  const sanitize = config.sanitizeError ?? defaultSanitizeError;

  // Wrap acquire so Redis errors carry agent/key context instead of bubbling
  // as opaque ioredis ReplyError.
  let acquired: boolean;
  try {
    acquired = await config.lock.acquire(lockKey, ttlMs);
  } catch (err) {
    const sErr = sanitize(err);
    log.error({ agentId: config.agentId, tickId, lockKey, err: sErr }, 'tick.lock_acquire_failed');
    throw new ConciergeError(
      'RpcError',
      `[@concierge/runtime] tick: lock acquire failed for agent '${config.agentId}'.`,
      sErr,
    );
  }
  if (!acquired) {
    log.info({ agentId: config.agentId, tickId, lockKey }, 'tick.skipped.lock_held');
    return { kind: 'skipped' };
  }

  // AbortSignal cancels at TTL - 5s so phases can clean-cancel before the
  // lock expires and a second worker races in.
  const abortCtl = new AbortController();
  const abortTimer = setTimeout(() => abortCtl.abort(), Math.max(0, ttlMs - ABORT_MARGIN_MS));

  try {
    const state = await config.loadState(config.agentId);

    const planOut = await runPhase(
      'plan',
      () => config.plan(state, abortCtl.signal),
      log,
      config.agentId,
      tickId,
      sanitize,
    );
    if (planOut.kind !== 'continue')
      return outcomeToResult('plan', planOut, log, config.agentId, tickId);

    const simOut = await runPhase(
      'simulate',
      () => config.simulate(state, planOut.data, abortCtl.signal),
      log,
      config.agentId,
      tickId,
      sanitize,
    );
    if (simOut.kind !== 'continue')
      return outcomeToResult('simulate', simOut, log, config.agentId, tickId);

    const propOut = await runPhase(
      'propose',
      () => config.propose(state, simOut.data, abortCtl.signal),
      log,
      config.agentId,
      tickId,
      sanitize,
    );
    if (propOut.kind !== 'continue')
      return outcomeToResult('propose', propOut, log, config.agentId, tickId);

    const execOut = await runPhase(
      'execute',
      () => config.execute(state, propOut.data, abortCtl.signal),
      log,
      config.agentId,
      tickId,
      sanitize,
    );
    if (execOut.kind !== 'continue')
      return outcomeToResult('execute', execOut, log, config.agentId, tickId);

    const recOut = await runPhase(
      'record',
      () => config.record(state, execOut.data, abortCtl.signal),
      log,
      config.agentId,
      tickId,
      sanitize,
    );
    if (recOut.kind !== 'continue') {
      // ADR-004 load-bearing: execute succeeded but record (attestation) did
      // NOT — distinct warn so operators can build a separate alert.
      log.warn({ agentId: config.agentId, tickId }, 'tick.execute_without_attestation');
      return outcomeToResult('record', recOut, log, config.agentId, tickId);
    }

    log.info(
      { agentId: config.agentId, tickId, attestation: recOut.data.attestationUid },
      'tick.completed',
    );
    return { kind: 'completed', attestation: recOut.data };
  } finally {
    clearTimeout(abortTimer);
    try {
      await config.lock.release(lockKey);
    } catch (releaseErr) {
      // TTL fallback handles the next tick; we surface the error object so
      // pino's err serializer keeps the stack + cause chain.
      log.error(
        { agentId: config.agentId, tickId, lockKey, err: sanitize(releaseErr) },
        'tick.lock_release_failed',
      );
    }
  }
}

/** Internal wrapper carrying thrown-vs-returned discrimination through to the result. */
type RunPhaseOutcome<T> =
  | { kind: 'continue'; data: T }
  | { kind: 'stop'; reason: string }
  | { kind: 'error'; error: Error; cause: 'thrown' | 'returned' };

async function runPhase<T>(
  phase: OrchestratedPhase,
  fn: () => Promise<PhaseOutcome<T>>,
  log: TickLogger,
  agentId: string,
  tickId: string,
  sanitize: (err: unknown) => Error,
): Promise<RunPhaseOutcome<T>> {
  const startedAt = Date.now();
  try {
    const out = await fn();
    const durationMs = Date.now() - startedAt;
    if (out.kind === 'continue') {
      log.info({ agentId, tickId, phase, durationMs }, 'tick.phase.continue');
      return out;
    }
    if (out.kind === 'stop') {
      log.info({ agentId, tickId, phase, durationMs, reason: out.reason }, 'tick.phase.stop');
      return out;
    }
    const sErr = sanitize(out.error);
    log.error(
      { agentId, tickId, phase, durationMs, err: sErr, cause: 'returned' },
      'tick.phase.error',
    );
    return { kind: 'error', error: sErr, cause: 'returned' };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const sErr = sanitize(err);
    log.error(
      { agentId, tickId, phase, durationMs, err: sErr, cause: 'thrown' },
      'tick.phase.thrown',
    );
    return { kind: 'error', error: sErr, cause: 'thrown' };
  }
}

function outcomeToResult(
  phase: OrchestratedPhase,
  outcome: RunPhaseOutcome<unknown>,
  log: TickLogger,
  agentId: string,
  tickId: string,
): TickResult {
  if (outcome.kind === 'stop') return { kind: 'stopped', phase, reason: outcome.reason };
  if (outcome.kind === 'error') {
    return { kind: 'errored', phase, error: outcome.error, cause: outcome.cause };
  }
  log.error({ agentId, tickId, phase }, 'tick.internal_unreachable');
  throw new ConciergeError(
    'ConfigError',
    `[@concierge/runtime] outcomeToResult: unexpected 'continue' for phase '${phase}'.`,
  );
}

const NOOP_LOGGER: TickLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
