export { createLock } from './lock.ts';
export { tick } from './tick.ts';
export type {
  AgentState,
  Attestation,
  Exec,
  ExecuteFn,
  OrchestratedPhase,
  PhaseOutcome,
  Plan,
  PlanFn,
  Proposal,
  ProposeFn,
  RecordFn,
  Sim,
  SimulateFn,
  TickConfig,
  TickLock,
  TickLogger,
  TickPhase,
  TickResult,
} from './types.ts';
export { ORCHESTRATED_PHASES, TICK_PHASES } from './types.ts';
