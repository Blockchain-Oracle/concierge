// Schema tests — happy + sad path per card, offset-datetime acceptance, CARD_SCHEMAS guard.

import { describe, expect, it } from 'vitest';
import {
  CARD_SCHEMAS,
  SerializablePortfolioCardSchema,
  SerializableProposalCardSchema,
  SerializableReputationCardSchema,
  SerializableTickCardSchema,
  safeParseSerializablePortfolioCard,
  safeParseSerializableProposalCard,
  safeParseSerializableReputationCard,
  safeParseSerializableTickCard,
} from '../serializable.ts';

describe('SerializableProposalCard', () => {
  it('accepts a minimal valid payload', () => {
    const r = safeParseSerializableProposalCard({
      id: 'p_42',
      actionSummary: 'Supply 100 USDC',
      estimatedAprDelta: 0.034,
      expectedHealthFactor: 2.1,
      expiresAt: '2026-06-09T13:00:00Z',
    });
    expect(r.success).toBe(true);
  });

  it('accepts +00:00-offset datetimes (Postgres timestamptz / indexer output)', () => {
    const r = safeParseSerializableProposalCard({
      id: 'p_1',
      actionSummary: 'x',
      estimatedAprDelta: 0,
      expiresAt: '2026-06-09T00:00:00+00:00',
    });
    expect(r.success).toBe(true);
  });

  it('rejects bad id prefix + non-string actionSummary + malformed txPreview.to', () => {
    const r = safeParseSerializableProposalCard({
      id: 'wrong',
      actionSummary: null,
      estimatedAprDelta: 0,
      expiresAt: '2026-06-09T00:00:00Z',
      txPreview: { to: '0xshort', value: '0', data: '0x' },
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path.join('.')) ?? [];
    expect(paths).toContain('id');
    expect(paths).toContain('actionSummary');
    expect(paths.some((p) => p.startsWith('txPreview.to'))).toBe(true);
  });
});

describe('SerializableTickCard', () => {
  it('accepts every TickPhase arm', () => {
    for (const phase of ['plan', 'simulate', 'propose', 'execute', 'record'] as const) {
      const r = safeParseSerializableTickCard({
        tickId: `t_${phase}`,
        agentId: 'agent_1',
        phase,
        startedAt: '2026-06-09T00:00:00Z',
        outcome: 'success',
      });
      expect(r.success, `phase=${phase}`).toBe(true);
    }
  });

  it('rejects unknown phase + wrong tickId prefix + bad outcome enum', () => {
    const r = safeParseSerializableTickCard({
      tickId: 'wrong',
      agentId: 'a',
      phase: 'decide',
      startedAt: '2026-06-09T00:00:00Z',
      outcome: 'maybe',
    });
    expect(r.success).toBe(false);
  });
});

describe('SerializablePortfolioCard', () => {
  it('accepts a payload with positions + totals', () => {
    const r = safeParseSerializablePortfolioCard({
      agentId: 'a_1',
      totalUsdValue: 1000,
      positions: [{ provider: 'aave-v3-mantle', symbol: 'aUSDC', amount: '100' }],
      healthFactor: 2.4,
      asOf: '2026-06-09T00:00:00Z',
    });
    expect(r.success).toBe(true);
  });

  it('rejects totalUsdValue as a string + Position.amount as a number (type-confusion)', () => {
    const r = safeParseSerializablePortfolioCard({
      agentId: 'a_1',
      totalUsdValue: '1000',
      positions: [{ provider: 'p', symbol: 's', amount: 100 }],
      asOf: '2026-06-09T00:00:00Z',
    });
    expect(r.success).toBe(false);
  });
});

describe('SerializableReputationCard', () => {
  it('accepts a valid payload', () => {
    const r = safeParseSerializableReputationCard({
      agentId: 'a_1',
      aggregateScore: 1.5,
      attestationCount: 5,
      recentAttestations: [
        {
          txHash: `0x${'a'.repeat(64)}`,
          value: 1.5,
          attestedAt: '2026-06-09T00:00:00Z',
        },
      ],
      registryAddress: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    });
    expect(r.success).toBe(true);
  });

  it('rejects float attestationCount + negative attestationCount + bad registryAddress', () => {
    for (const bad of [
      { attestationCount: 3.5 },
      { attestationCount: -1 },
      { registryAddress: '0xshort' },
    ]) {
      const r = safeParseSerializableReputationCard({
        agentId: 'a',
        aggregateScore: 0,
        attestationCount: 0,
        recentAttestations: [],
        registryAddress: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
        ...bad,
      });
      expect(r.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects recentAttestations > 50 (cap is policy-bearing for UI)', () => {
    const r = safeParseSerializableReputationCard({
      agentId: 'a',
      aggregateScore: 0,
      attestationCount: 51,
      recentAttestations: Array.from({ length: 51 }, () => ({
        txHash: `0x${'a'.repeat(64)}`,
        value: 0,
        attestedAt: '2026-06-09T00:00:00Z',
      })),
      registryAddress: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    });
    expect(r.success).toBe(false);
  });
});

describe('IsoDateTime offset-suffix coverage on every card', () => {
  // The shared IsoDateTime helper accepts `+00:00` (Postgres timestamptz / indexer
  // output / AI date strings). One test per schema field locks the contract.
  const OFFSET = '2026-06-09T00:00:00+00:00';

  it('proposal.expiresAt', () => {
    expect(
      safeParseSerializableProposalCard({
        id: 'p_1',
        actionSummary: 'x',
        estimatedAprDelta: 0,
        expiresAt: OFFSET,
      }).success,
    ).toBe(true);
  });

  it('tick.startedAt + .endedAt', () => {
    expect(
      safeParseSerializableTickCard({
        tickId: 't_1',
        agentId: 'a',
        phase: 'plan',
        startedAt: OFFSET,
        endedAt: OFFSET,
        outcome: 'success',
      }).success,
    ).toBe(true);
  });

  it('portfolio.asOf', () => {
    expect(
      safeParseSerializablePortfolioCard({
        agentId: 'a',
        totalUsdValue: 0,
        positions: [],
        asOf: OFFSET,
      }).success,
    ).toBe(true);
  });

  it('reputation.recentAttestations[].attestedAt', () => {
    expect(
      safeParseSerializableReputationCard({
        agentId: 'a',
        aggregateScore: 0,
        attestationCount: 0,
        recentAttestations: [{ txHash: `0x${'a'.repeat(64)}`, value: 0, attestedAt: OFFSET }],
        registryAddress: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      }).success,
    ).toBe(true);
  });
});

describe('CARD_SCHEMAS map', () => {
  it('exposes every UICardId arm with its schema (compile-time satisfies + runtime presence)', () => {
    expect(CARD_SCHEMAS.proposal).toBe(SerializableProposalCardSchema);
    expect(CARD_SCHEMAS.tick).toBe(SerializableTickCardSchema);
    expect(CARD_SCHEMAS.portfolio).toBe(SerializablePortfolioCardSchema);
    expect(CARD_SCHEMAS.reputation).toBe(SerializableReputationCardSchema);
  });
});
