import { ConciergeError } from '@concierge/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, Plan } from '../../types.ts';
import {
  decideRequiresApproval,
  type NewProposalRow,
  type ProposalPublisher,
  type ProposalRepository,
  runPropose,
} from '../propose.ts';
import type { DetailedSim } from '../simulate.ts';

afterEach(() => vi.restoreAllMocks());

const STATE: AgentState = {
  agentId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  chain: 'mantle-sepolia',
  goal: 'idle yield',
  policyId: 'p',
  recentTicks: [],
  openPositions: [],
};
const TICK_ID = '00000000-0000-0000-0000-000000000003';
const PROPOSAL_ID = '00000000-0000-0000-0000-000000000004';
const NOW = new Date('2026-06-13T10:00:00Z');

const HF_BEFORE = 2_000_000_000_000_000_000n;
const HF_HEALTHY = 1_900_000_000_000_000_000n;
const HF_FLOOR = 1_500_000_000_000_000_000n;
const HF_NEAR_FLOOR = 1_550_000_000_000_000_000n; // within 10% buffer

function simOf(healthFactorAfter: bigint, warnings: string[] = []): DetailedSim {
  return {
    ok: true,
    gasEstimateWei: 100_000n,
    expectedValueDeltaUsd: null,
    warnings,
    deltaState: {
      healthFactorBefore: HF_BEFORE,
      healthFactorAfter,
      balanceDeltas: Object.freeze({}),
      debtDeltas: Object.freeze({}),
      oracleChecks: Object.freeze({ stale: false }),
    },
  };
}

const PLAN: Plan = {
  intent: 'rebalance',
  providerCalls: [{ provider: 'aave', action: 'supply', args: {} }],
};

function makeRepo(over: Partial<ProposalRepository> = {}): ProposalRepository {
  return {
    findPendingByAgent: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue({ id: PROPOSAL_ID }),
    ...over,
  };
}

function makePub(): ProposalPublisher & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue(undefined);
  return { publish: mock, mock };
}

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
    if (out.kind === 'continue') expect(out.data.requiresApproval).toBe(true);
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
    if (out.kind === 'continue') expect(out.data.requiresApproval).toBe(true);
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
    if (out.kind === 'continue') expect(out.data.requiresApproval).toBe(true);
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
      expect(out.data.requiresApproval).toBe(true);
    }
    expect(repo.insert).not.toHaveBeenCalled();
    expect(pub.mock).not.toHaveBeenCalled();
  });
});

describe('runPropose — boundary validation', () => {
  it('unknown kind → ConciergeError(InvariantViolation)', async () => {
    await expect(
      runPropose(
        {
          state: STATE,
          tickId: TICK_ID,
          plan: PLAN,
          sim: simOf(HF_HEALTHY),
          // biome-ignore lint/suspicious/noExplicitAny: deliberate
          kind: 'evil' as any,
          protocol: 'aave',
          amountUsd: 25,
          hypothesis: '',
        },
        { repository: makeRepo(), publisher: makePub(), now: () => NOW },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ConciergeError && e.type === 'InvariantViolation',
    );
  });

  it('negative amount → InvariantViolation', async () => {
    await expect(
      runPropose(
        {
          state: STATE,
          tickId: TICK_ID,
          plan: PLAN,
          sim: simOf(HF_HEALTHY),
          kind: 'supply',
          protocol: 'aave',
          amountUsd: -1,
          hypothesis: '',
        },
        { repository: makeRepo(), publisher: makePub(), now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ConciergeError);
  });

  it('NaN amount → InvariantViolation', async () => {
    await expect(
      runPropose(
        {
          state: STATE,
          tickId: TICK_ID,
          plan: PLAN,
          sim: simOf(HF_HEALTHY),
          kind: 'supply',
          protocol: 'aave',
          amountUsd: Number.NaN,
          hypothesis: '',
        },
        { repository: makeRepo(), publisher: makePub(), now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(ConciergeError);
  });
});

describe('runPropose — infra failures (THROW as ConciergeError)', () => {
  it('repository.insert throws → ConciergeError(RpcError) with sanitized cause', async () => {
    const repo = makeRepo({
      insert: vi.fn().mockRejectedValue(new Error('conn lost at ?apikey=LEAKED')),
    });
    await expect(
      runPropose(
        {
          state: STATE,
          tickId: TICK_ID,
          plan: PLAN,
          sim: simOf(HF_HEALTHY),
          kind: 'supply',
          protocol: 'aave',
          amountUsd: 25,
          hypothesis: '',
        },
        { repository: repo, publisher: makePub(), now: () => NOW },
      ),
    ).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof ConciergeError)) return false;
      return e.type === 'RpcError' && !JSON.stringify(e).includes('LEAKED');
    });
  });

  it('publisher.publish throws → ConciergeError(RpcError)', async () => {
    const pub: ProposalPublisher = {
      publish: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    await expect(
      runPropose(
        {
          state: STATE,
          tickId: TICK_ID,
          plan: PLAN,
          sim: simOf(HF_HEALTHY),
          kind: 'supply',
          protocol: 'aave',
          amountUsd: 25,
          hypothesis: '',
        },
        { repository: makeRepo(), publisher: pub, now: () => NOW },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof ConciergeError && e.type === 'RpcError');
  });
});
