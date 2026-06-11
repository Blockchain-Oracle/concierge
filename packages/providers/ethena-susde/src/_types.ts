export interface YieldRateResult {
  /** Annualised protocol yield in basis points (funding-rate component). */
  readonly protocolYieldBps: number;
  /** Annualised staking yield in basis points (combined protocol + staking). */
  readonly stakingYieldBps: number;
  /** The yield figure used for carry calculations (combinedYield). */
  readonly susdeYieldBps: number;
}

export interface CarryVsAaveResult {
  readonly susdeYieldBps: number;
  readonly usdcBorrowBps: number;
  /** susdeYieldBps - usdcBorrowBps — negative when carry inverts. */
  readonly carryBps: number;
  /** true when carryBps >= spreadFloor; false triggers agent auto-deleverage. */
  readonly spreadFloorPassing: boolean;
}
