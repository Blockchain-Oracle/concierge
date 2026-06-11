export interface YieldRateResult {
  /** Annualised protocol yield in basis points (funding-rate component). */
  protocolYieldBps: number;
  /** Annualised staking yield in basis points (combined protocol + staking). */
  stakingYieldBps: number;
  /** The yield figure used for carry calculations (combinedYield). */
  susdeYieldBps: number;
}

export interface CarryVsAaveResult {
  susdeYieldBps: number;
  usdcBorrowBps: number;
  /** susdeYieldBps - usdcBorrowBps — negative when carry inverts. */
  carryBps: number;
  /** true when carryBps >= spreadFloor; false triggers agent auto-deleverage. */
  spreadFloorPassing: boolean;
}
