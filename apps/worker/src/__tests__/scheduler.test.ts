import { ConciergeError } from '@concierge/sdk';
import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleAgentTicks, unscheduleAgentTicks } from '../scheduler.ts';

afterEach(() => vi.restoreAllMocks());

function fakeQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'jid-1' }),
    removeJobScheduler: vi.fn().mockResolvedValue(true),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;
}

describe('scheduleAgentTicks', () => {
  it('adds repeatable job with key=tick-${agentId} (dedup signal)', async () => {
    const q = fakeQueue();
    await scheduleAgentTicks(q, { agentId: 'agent-1', cadenceMs: 60_000 });
    const call = (q.add as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[2]?.repeat?.key).toBe('tick-agent-1');
    expect(call?.[2]?.repeat?.every).toBe(60_000);
  });

  it('rejects malformed agentId (CWE-20 boundary)', async () => {
    const q = fakeQueue();
    await expect(
      scheduleAgentTicks(q, { agentId: 'bad agent:id', cadenceMs: 60_000 }),
    ).rejects.toBeInstanceOf(ConciergeError);
  });

  it('rejects cadence below 5s floor', async () => {
    const q = fakeQueue();
    await expect(
      scheduleAgentTicks(q, { agentId: 'agent-1', cadenceMs: 1_000 }),
    ).rejects.toBeInstanceOf(ConciergeError);
  });

  it('rejects NaN cadence', async () => {
    const q = fakeQueue();
    await expect(
      scheduleAgentTicks(q, { agentId: 'agent-1', cadenceMs: Number.NaN }),
    ).rejects.toBeInstanceOf(ConciergeError);
  });

  it('returning the same key re-adds with new cadence (dedup is queue-side)', async () => {
    const q = fakeQueue();
    await scheduleAgentTicks(q, { agentId: 'agent-1', cadenceMs: 30_000 });
    await scheduleAgentTicks(q, { agentId: 'agent-1', cadenceMs: 60_000 });
    expect((q.add as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    // Both calls use the same repeat.key → BullMQ deduplicates server-side.
    const k0 = (q.add as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]?.repeat?.key;
    const k1 = (q.add as ReturnType<typeof vi.fn>).mock.calls[1]?.[2]?.repeat?.key;
    expect(k0).toBe(k1);
  });
});

describe('unscheduleAgentTicks', () => {
  it('forwards to queue.removeJobScheduler with tick-${agentId}', async () => {
    const q = fakeQueue();
    const ok = await unscheduleAgentTicks(q, 'agent-1');
    expect(ok).toBe(true);
    expect(q.removeJobScheduler).toHaveBeenCalledWith('tick-agent-1');
  });

  it('rejects malformed agentId', async () => {
    const q = fakeQueue();
    await expect(unscheduleAgentTicks(q, 'bad agent')).rejects.toBeInstanceOf(ConciergeError);
  });
});
