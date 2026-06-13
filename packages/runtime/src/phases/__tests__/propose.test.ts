import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideRequiresApproval,
  type NewProposalRow,
  type ProposalPublisher,
  type ProposalRepository,
  runPropose,
} from '../propose.ts';
import {
  HF_BEFORE,
  HF_FLOOR,
  HF_HEALTHY,
  HF_NEAR_FLOOR,
  makePub,
  makeRepo,
  NOW,
  PLAN,
  PROPOSAL_ID,
  STATE,
  simOf,
  TICK_ID,
} from './_proposeFixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('decideRequiresApproval — pure decision logic', () => {
  const base = {
    healthFactorAfter: HF_HEALTHY,
    hfFloor: HF_FLOOR,
    hfBufferBps: 1000n,
    autoApprovalThresholdUSD: 50,
    riskFlagged: false,
  };

  it('amount ≤ threshold + healthy HF + no risk → false (auto-approve)', () => {
    expect(decideRequiresApproval({ ...base, amountUsd: 25 })).toBe(false);
  });

  it('amount > threshold → true', () => {
    expect(decideRequiresApproval({ ...base, amountUsd: 100 })).toBe(true);
  });

  it('amount EQUAL to threshold → false (strict >)', () => {
    expect(decideRequiresApproval({ ...base, amountUsd: 50 })).toBe(false);
  });

  it('HF within buffer of floor → true', () => {
    expect(
      decideRequiresApproval({ ...base, amountUsd: 25, healthFactorAfter: HF_NEAR_FLOOR }),
    ).toBe(true);
  });

  it('HF exactly at threshold (floor × 1.10) → false', () => {
    // floor * 1.1 = 1.65e18 exactly
    const exact = 1_650_000_000_000_000_000n;
    expect(decideRequiresApproval({ ...base, amountUsd: 25, healthFactorAfter: exact })).toBe(
      false,
    );
  });

  it('riskFlagged short-circuits regardless of amount or HF', () => {
    expect(decideRequiresApproval({ ...base, amountUsd: 1, riskFlagged: true })).toBe(true);
  });
});

describe('runPropose — happy paths', () => {
  it('small action + healthy HF → inserts row with requiresApproval=false', async () => {
    const repo = makeRepo();
    const pub = makePub();
    const out = await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_HEALTHY),
        kind: 'supply',
        protocol: 'aave',
        amountUsd: 25,
        hypothesis: 'test',
      },
      { repository: repo, publisher: pub, now: () => NOW },
    );
    expect(out.kind).toBe('continue');
    if (out.kind !== 'continue') return;
    expect(out.data.kind).toBe('created');
    expect(out.data.requiresApproval).toBe(false);
    const insertedRow = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | NewProposalRow
      | undefined;
    expect(insertedRow?.requiresApproval).toBe(false);
    expect(insertedRow?.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('large action (> $50) → requiresApproval=true', async () => {
    const repo = makeRepo();
    const pub = makePub();
    const out = await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_HEALTHY),
        kind: 'supply',
        protocol: 'aave',
        amountUsd: 100,
        hypothesis: 'big',
      },
      { repository: repo, publisher: pub, now: () => NOW },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue' && out.data.kind === 'created') {
      expect(out.data.requiresApproval).toBe(true);
    }
  });

  it('near-HF-floor → requiresApproval=true even for small action', async () => {
    const out = await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_NEAR_FLOOR),
        kind: 'borrow',
        protocol: 'aave',
        amountUsd: 10,
        hypothesis: 'tight',
      },
      { repository: makeRepo(), publisher: makePub(), now: () => NOW },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue' && out.data.kind === 'created') {
      expect(out.data.requiresApproval).toBe(true);
    }
  });

  it('riskFlagged → requiresApproval=true regardless of amount', async () => {
    const out = await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_HEALTHY),
        kind: 'swap',
        protocol: 'merchant-moe',
        amountUsd: 1,
        hypothesis: 'risky',
        riskFlagged: true,
      },
      { repository: makeRepo(), publisher: makePub(), now: () => NOW },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue' && out.data.kind === 'created') {
      expect(out.data.requiresApproval).toBe(true);
    }
  });
});

describe('runPropose — SSE event payload', () => {
  it('publishes to user:${userId}:proposals with correct shape', async () => {
    const repo = makeRepo();
    const pub = makePub();
    await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_HEALTHY),
        kind: 'supply',
        protocol: 'aave',
        amountUsd: 100,
        hypothesis: 'lend USDC',
      },
      { repository: repo, publisher: pub, now: () => NOW },
    );
    expect(pub.mock).toHaveBeenCalledTimes(1);
    const [channel, payload] = pub.mock.mock.calls[0] ?? [];
    expect(channel).toBe(`user:${STATE.userId}:proposals`);
    const parsed = JSON.parse(payload as string);
    expect(parsed.type).toBe('proposal.created');
    expect(parsed.proposalId).toBe(PROPOSAL_ID);
    expect(parsed.kind).toBe('supply');
    expect(parsed.protocol).toBe('aave');
    expect(parsed.amountUsd).toBe(100);
    expect(parsed.projectedHfBefore).toBe(HF_BEFORE.toString());
    expect(parsed.projectedHfAfter).toBe(HF_HEALTHY.toString());
    expect(parsed.requiresApproval).toBe(true);
    expect(parsed.hypothesis).toBe('lend USDC');
    expect(parsed.expiresAt).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
  });

  it('hypothesis truncated to 2000 chars (DoS guard on SSE payload)', async () => {
    const pub = makePub();
    await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_HEALTHY),
        kind: 'supply',
        protocol: 'aave',
        amountUsd: 25,
        hypothesis: 'x'.repeat(5000),
      },
      { repository: makeRepo(), publisher: pub, now: () => NOW },
    );
    const payload = JSON.parse(pub.mock.mock.calls[0]?.[1] as string);
    expect(payload.hypothesis.length).toBe(2000);
  });
});

describe('runPropose — idempotence', () => {
  it('existing pending → returns already_pending; does NOT insert; does NOT publish', async () => {
    const repo = makeRepo({
      findPendingByAgent: vi.fn().mockResolvedValue({ id: 'existing-id' }),
    });
    const pub = makePub();
    const out = await runPropose(
      {
        state: STATE,
        tickId: TICK_ID,
        plan: PLAN,
        sim: simOf(HF_HEALTHY),
        kind: 'supply',
        protocol: 'aave',
        amountUsd: 25,
        hypothesis: 'test',
      },
      { repository: repo, publisher: pub, now: () => NOW },
    );
    expect(out.kind).toBe('continue');
    if (out.kind === 'continue') {
      expect(out.data.kind).toBe('already_pending');
      expect(out.data.proposalId).toBe('existing-id');
      // round-2: already_pending no longer carries fabricated requiresApproval
    }
    expect(repo.insert).not.toHaveBeenCalled();
    expect(pub.mock).not.toHaveBeenCalled();
  });
});
