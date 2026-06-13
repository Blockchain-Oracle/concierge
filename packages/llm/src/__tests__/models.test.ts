import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_BY_PHASE,
  MODEL_HAIKU,
  MODEL_OPUS,
  MODEL_SONNET,
  routeModelForPhase,
} from '../models.ts';
import type { TickPhase } from '../types.ts';
import { assertModel, isModel, isTickPhase, MODELS, TICK_PHASES } from '../types.ts';

describe('model constants (ADR-006 + system-declared 2026-06-13 model family)', () => {
  // Exact match — these are pinned per system-prompt declaration. Sonnet/Opus
  // are UNDATED, Haiku is DATED. Mix is intentional, not a typo.
  it('Sonnet 4.6 id is exact', () => {
    expect(MODEL_SONNET).toBe('claude-sonnet-4-6');
  });

  it('Opus 4.7 id is exact', () => {
    expect(MODEL_OPUS).toBe('claude-opus-4-7');
  });

  it('Haiku 4.5 id is exact', () => {
    expect(MODEL_HAIKU).toBe('claude-haiku-4-5-20251001');
  });

  it('MODELS array matches the published constants', () => {
    expect([...MODELS].sort()).toEqual([MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET].sort());
  });
});

describe('routeModelForPhase', () => {
  // Table-driven exhaustiveness — adding a phase forces a row here.
  const PHASE_TABLE: Array<{
    phase: TickPhase;
    expected: typeof MODEL_SONNET | typeof MODEL_HAIKU;
  }> = [
    { phase: 'plan', expected: MODEL_SONNET },
    { phase: 'simulate', expected: MODEL_SONNET },
    { phase: 'propose', expected: MODEL_SONNET },
    { phase: 'decide', expected: MODEL_SONNET },
    { phase: 'execute', expected: MODEL_SONNET },
    { phase: 'record', expected: MODEL_HAIKU },
  ];

  for (const { phase, expected } of PHASE_TABLE) {
    it(`${phase} → ${expected}`, () => {
      expect(routeModelForPhase(phase)).toBe(expected);
    });
  }

  it('covers every TickPhase exactly once', () => {
    expect(PHASE_TABLE.map((r) => r.phase).sort()).toEqual([...TICK_PHASES].sort());
  });

  it('decide with riskFlagged === true → Opus', () => {
    expect(routeModelForPhase('decide', { riskFlagged: true })).toBe(MODEL_OPUS);
  });

  it('decide with riskFlagged === false (not truthy-only check) → Sonnet', () => {
    expect(routeModelForPhase('decide', { riskFlagged: false })).toBe(MODEL_SONNET);
  });

  it('throws ConciergeError on unknown phase (typed discriminator for JS callers)', () => {
    try {
      routeModelForPhase('mystery' as unknown as TickPhase);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConciergeError);
      expect((e as ConciergeError).type).toBe('ConfigError');
      expect((e as ConciergeError).message).toMatch(/unknown phase/);
    }
  });

  it('DEFAULT_MODEL_BY_PHASE matches routeModelForPhase for non-risk-flagged decide', () => {
    for (const phase of TICK_PHASES) {
      expect(routeModelForPhase(phase)).toBe(DEFAULT_MODEL_BY_PHASE[phase]);
    }
  });
});

describe('runtime narrowers (silent-failure C1 — JS-caller boundary)', () => {
  it('isModel: true for known models, false otherwise', () => {
    expect(isModel(MODEL_SONNET)).toBe(true);
    expect(isModel(MODEL_OPUS)).toBe(true);
    expect(isModel(MODEL_HAIKU)).toBe(true);
    expect(isModel('claude-sonnet-4.6')).toBe(false); // dot instead of dash
    expect(isModel(123)).toBe(false);
    expect(isModel(null)).toBe(false);
  });

  it('assertModel: returns narrowed value on hit', () => {
    expect(assertModel(MODEL_SONNET)).toBe(MODEL_SONNET);
  });

  it('assertModel: throws with EVERY valid model id on miss (catches partial-drop regression)', () => {
    expect(() => assertModel('claude-sonnet-4.6')).toThrow(/Expected one of:/);
    expect(() => assertModel('claude-sonnet-4.6')).toThrow(/claude-sonnet-4-6/);
    expect(() => assertModel('claude-sonnet-4.6')).toThrow(/claude-opus-4-7/);
    expect(() => assertModel('claude-sonnet-4.6')).toThrow(/claude-haiku-4-5/);
  });

  it('isTickPhase: matches frozen TICK_PHASES set', () => {
    for (const phase of TICK_PHASES) expect(isTickPhase(phase)).toBe(true);
    expect(isTickPhase('plann')).toBe(false);
    expect(isTickPhase(42)).toBe(false);
  });
});
