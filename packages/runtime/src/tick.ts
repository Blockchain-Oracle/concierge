import { randomUUID } from 'node:crypto';
import { ConciergeError } from '@concierge/sdk';
import { sanitizeError as defaultSanitize } from './sanitize.ts';
import type {
  OrchestratedPhase,
  PhaseOutcome,
  TickConfig,
  TickLogger,
  TickResult,
} from './types.ts';

const DEFAULT_LOCK_TTL_MS = 60_000;
const ABORT_MARGIN_MS = 5_000;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Wrap the caller's sanitizeError so a buggy override can't throw out of tick. */
function safeSanitize(sanitize: (err: unknown) => Error, err: unknown): Error {
  try {
    return sanitize(err);
  } catch {
    try {
      return defaultSanitize(err);
    } catch {
      return new Error('<sanitize failed>');
    }
  }
}

function assertConfigShape(config: TickConfig): void {
  if (!AGENT_ID_RE.test(config.agentId)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] tick: agentId must match ${AGENT_ID_RE.source}.`,
    );
  }
  const ttl = config.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  if (ttl <= ABORT_MARGIN_MS) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] tick: lockTtlMs (${ttl}) MUST exceed ABORT_MARGIN_MS (${ABORT_MARGIN_MS}) or phases abort before they run.`,
    );
  }
  // Defensive shape check at the JS boundary — MCP / AgentKit / LangChain
  // adapters may construct TickConfig from non-TS sources (per ADR-014).
  for (const field of ['loadState', 'plan', 'simulate', 'propose', 'execute', 'record'] as const) {
    if (typeof config[field] !== 'function') {
      throw new ConciergeError(
        'ConfigError',
        `[@concierge/runtime] tick: required config field '${field}' is missing or not a function.`,
      );
    }
  }
  if (!config.lock || typeof config.lock.acquire !== 'function') {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/runtime] tick: required config field 'lock' is missing or malformed.`,
    );
  }
}

/**
 * Tick orchestrator. Sequences the 5-phase agent run (decide is out-of-loop)
 * under a Redis NX lock. Phases DI-injected. Each phase receives an
 * AbortSignal that fires at `lockTtlMs - 5s`; the orchestrator ALSO checks
 * `signal.aborted` between phases so a phase that ignored the signal can't
 * cascade work after the lock has expired.
 */
export async function tick(config: TickConfig): Promise<TickResult> {
  assertConfigShape(config);

  const ttlMs = config.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const lockKey = `lock:agent:${config.agentId}`;
  const log = config.logger ?? NOOP_LOGGER;
  const tickId = randomUUID();
  const callerSanitize = config.sanitizeError ?? defaultSanitize;
  const sanitize = (err: unknown) => safeSanitize(callerSanitize, err);

  let acquired: boolean;
  try {
    acquired = await config.lock.acquire(lockKey, ttlMs);
  } catch (err) {
    const sErr = sanitize(err);
    log.error({ agentId: config.agentId, tickId, lockKey, err: sErr }, 'tick.lock_acquire_failed');
    throw new ConciergeError(
      'LockError',
      `[@concierge/runtime] tick: lock acquire failed for agent '${config.agentId}'.`,
      sErr,
    );
  }
  if (!acquired) {
    log.info({ agentId: config.agentId, tickId, lockKey }, 'tick.skipped.lock_held');
    return { kind: 'skipped' };
  }

  const abortCtl = new AbortController();
  const abortTimer = setTimeout(() => abortCtl.abort(), ttlMs - ABORT_MARGIN_MS);

  // Closure-capture phase runner: each call site shrinks to two lines.
  const run = <T>(phase: OrchestratedPhase, fn: () => Promise<PhaseOutcome<T>>) =>
    runPhase(phase, fn, log, config.agentId, tickId, sanitize);

  /** Between-phase abort defense — phase fn may have ignored the signal. */
  const checkAborted = (nextPhase: OrchestratedPhase): TickResult | null => {
    if (!abortCtl.signal.aborted) return null;
    log.warn({ agentId: config.agentId, tickId, nextPhase }, 'tick.aborted_before_phase');
    return { kind: 'aborted', phase: nextPhase, reason: 'ttl_exceeded' };
  };

  try {
    const state = await config.loadState(config.agentId).catch((err: unknown) => {
      // Apply the same sanitize boundary as the phase chain — loadState
      // touches the DB and may carry a credentialed connection-string in
      // its error message.
      throw sanitize(err);
    });

    let aborted = checkAborted('plan');
    if (aborted) return aborted;
    const planOut = await run('plan', () => config.plan(state, abortCtl.signal));
    if (planOut.kind !== 'continue') return toResult('plan', planOut);

    aborted = checkAborted('simulate');
    if (aborted) return aborted;
    const simOut = await run('simulate', () =>
      config.simulate(state, planOut.data, abortCtl.signal),
    );
    if (simOut.kind !== 'continue') return toResult('simulate', simOut);

    aborted = checkAborted('propose');
    if (aborted) return aborted;
    const propOut = await run('propose', () => config.propose(state, simOut.data, abortCtl.signal));
    if (propOut.kind !== 'continue') return toResult('propose', propOut);

    aborted = checkAborted('execute');
    if (aborted) return aborted;
    const execOut = await run('execute', () =>
      config.execute(state, propOut.data, abortCtl.signal),
    );
    if (execOut.kind !== 'continue') return toResult('execute', execOut);

    aborted = checkAborted('record');
    if (aborted) return aborted;
    const recOut = await run('record', () => config.record(state, execOut.data, abortCtl.signal));
    if (recOut.kind !== 'continue') {
      log.warn({ agentId: config.agentId, tickId }, 'tick.execute_without_attestation');
      return toResult('record', recOut);
    }

    log.info(
      { agentId: config.agentId, tickId, attestation: recOut.data.attestationUid },
      'tick.completed',
    );
    return { kind: 'completed', attestation: recOut.data };
  } finally {
    clearTimeout(abortTimer);
    try {
      const outcome = await config.lock.release(lockKey);
      if (outcome === 'nonce-mismatch') {
        // The Lua CAS rejected the DEL — our nonce no longer owns the lock,
        // which means TTL expired and another worker has it. This is the
        // exact double-execute window the lock exists to prevent.
        log.error({ agentId: config.agentId, tickId, lockKey }, 'tick.lock_release_nonce_mismatch');
      } else if (outcome === 'not-held') {
        log.warn({ agentId: config.agentId, tickId, lockKey }, 'tick.lock_release_no_nonce');
      }
    } catch (releaseErr) {
      log.error(
        { agentId: config.agentId, tickId, lockKey, err: sanitize(releaseErr) },
        'tick.lock_release_failed',
      );
    }
  }
}

/**
 * Runs a phase function, normalising any returned `error` outcome AND any
 * thrown value to the orchestrator-internal shape `{ kind: 'error', error,
 * cause }`. `cause: 'thrown'` means the phase function threw (likely
 * programmer bug); `cause: 'returned'` means it returned a typed error
 * (legitimate domain failure). Both are sanitized before they touch logs or
 * the final TickResult.
 */
async function runPhase<T>(
  phase: OrchestratedPhase,
  fn: () => Promise<PhaseOutcome<T>>,
  log: TickLogger,
  agentId: string,
  tickId: string,
  sanitize: (err: unknown) => Error,
): Promise<
  | { kind: 'continue'; data: T }
  | { kind: 'stop'; reason: string }
  | { kind: 'error'; error: Error; cause: 'thrown' | 'returned' }
> {
  const startedAt = performance.now();
  try {
    const out = await fn();
    const durationMs = Math.round(performance.now() - startedAt);
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
    const durationMs = Math.round(performance.now() - startedAt);
    const sErr = sanitize(err);
    log.error(
      { agentId, tickId, phase, durationMs, err: sErr, cause: 'thrown' },
      'tick.phase.thrown',
    );
    return { kind: 'error', error: sErr, cause: 'thrown' };
  }
}

function toResult(
  phase: OrchestratedPhase,
  outcome:
    | { kind: 'stop'; reason: string }
    | { kind: 'error'; error: Error; cause: 'thrown' | 'returned' },
): TickResult {
  if (outcome.kind === 'stop') return { kind: 'stopped', phase, reason: outcome.reason };
  return { kind: 'errored', phase, error: outcome.error, cause: outcome.cause };
}

const NOOP_LOGGER: TickLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
