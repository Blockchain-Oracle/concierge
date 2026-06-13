import { ConciergeError } from '@concierge/sdk';
import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDlq, type DlqRecord } from '../dlq.ts';

afterEach(() => vi.restoreAllMocks());

function fakeQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'dlq-job-1' }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;
}

const RECORD: DlqRecord = {
  agentId: 'agent-1',
  attempts: 3,
  failedReason: 'rpc dropped',
  failedAt: '2026-06-13T11:00:00Z',
};

describe('createDlq.enqueue', () => {
  it('adds to dlq-tick job; payload survives', async () => {
    const q = fakeQueue();
    const dlq = createDlq(q);
    await dlq.enqueue(RECORD);
    const call = (q.add as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe('dlq-tick');
    expect(call?.[1].agentId).toBe('agent-1');
    expect(call?.[1].attempts).toBe(3);
  });

  it('caps failedReason at 4096 chars (DoS guard)', async () => {
    const q = fakeQueue();
    const dlq = createDlq(q);
    await dlq.enqueue({ ...RECORD, failedReason: 'x'.repeat(20_000) });
    const call = (q.add as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[1].failedReason.length).toBe(4096);
  });

  it('keeps payload on complete + on fail (manual review)', async () => {
    const q = fakeQueue();
    const dlq = createDlq(q);
    await dlq.enqueue(RECORD);
    const opts = (q.add as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
    expect(opts.removeOnComplete).toBe(false);
    expect(opts.removeOnFail).toBe(false);
  });

  it('rejects malformed agentId', async () => {
    const q = fakeQueue();
    const dlq = createDlq(q);
    await expect(dlq.enqueue({ ...RECORD, agentId: 'bad agent' })).rejects.toBeInstanceOf(
      ConciergeError,
    );
  });
});
