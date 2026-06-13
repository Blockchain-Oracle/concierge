import type { DbClient } from '@concierge/db';
import type { Address, Hex } from 'viem';
import { type EnqueueInput, enqueue } from './queue.ts';

/**
 * Event payload broadcast to the user's connected web session so the UI can
 * pop the proposal modal (story-108). Decoupled from any specific transport
 * (SSE, WebSocket, Redis pub/sub) — caller injects an emitter.
 *
 * SECURITY: the transport MUST be per-user-scoped. Implementers must route
 * on `userId` (e.g. per-user SSE topic, Redis channel `user:{userId}`). Do
 * NOT fan out to a shared topic — that would leak trading strategy + capital
 * sizing (`to`/`data`/`value`) across tenants.
 */
export interface ProposalEvents {
  'eoa.proposal.pending': {
    queueId: string;
    userId: string;
    agentId: string;
    to: Address;
    data: Hex;
    value: string;
    createdAt: Date;
  };
}

export interface ProposalEventEmitter {
  emit<E extends keyof ProposalEvents>(event: E, payload: ProposalEvents[E]): void | Promise<void>;
}

export interface ProposeForUserConfig {
  readonly db: DbClient;
  readonly txParams: EnqueueInput;
  readonly events?: ProposalEventEmitter;
}

export interface ProposeForUserResult {
  readonly queueId: string;
  readonly createdAt: Date;
}

/**
 * Inserts a pending eoa_tx_queue row and (optionally) emits an event so the
 * connected web session pops the proposal modal. The agent runtime calls
 * this; the UI sender (story-108) collects the user's signed tx and calls
 * `sendSignedTx` (sender.ts).
 *
 * Event-emit failures are logged but non-fatal — the row is authoritative;
 * the UI can poll `getPending` on reconnect if it missed the live event.
 */
export async function proposeForUser(config: ProposeForUserConfig): Promise<ProposeForUserResult> {
  const { id, createdAt } = await enqueue(config.db, config.txParams);
  if (config.events) {
    try {
      await config.events.emit('eoa.proposal.pending', {
        queueId: id,
        userId: config.txParams.userId,
        agentId: config.txParams.agentId,
        to: config.txParams.to,
        data: config.txParams.data,
        value: config.txParams.value,
        createdAt,
      });
    } catch (err) {
      // Sanitize: emitter errors may carry Redis/SSE URLs with apikeys.
      const sanitizedMsg =
        err instanceof Error
          ? err.message.replace(
              /([?&](?:api[_-]?key|key|token|secret)=)[^&\s"'<>]+/gi,
              '$1<redacted>',
            )
          : String(err);
      // biome-ignore lint/suspicious/noConsole: proposal event drop must be observable
      console.error(
        `[@concierge/smart-account] proposeForUser: eoa.proposal.pending emit failed (non-fatal — row queued, UI can poll)`,
        { queueId: id, agentId: config.txParams.agentId, error: sanitizedMsg },
      );
    }
  }
  return { queueId: id, createdAt };
}
