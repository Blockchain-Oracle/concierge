import { ConciergeError } from '@concierge/sdk';

/**
 * Per-agent identifier shape. Bounded length + no `:` `*` whitespace `\n`
 * prevents Redis-key injection at BullMQ schedule keys, tickJob.agentId
 * interpolation, and DLQ payloads. Single source of truth across scheduler,
 * tickJob, and dlq modules.
 */
export const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function assertAgentId(id: unknown, where: string): asserts id is string {
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) {
    throw new ConciergeError(
      'InvariantViolation',
      `[@concierge/worker] ${where}: agentId must match ${AGENT_ID_RE.source}.`,
    );
  }
}
