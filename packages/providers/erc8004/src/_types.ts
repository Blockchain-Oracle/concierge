// Internal type module — not exported from index.ts.

// Structural subset of viem's TransactionReceipt log shape.
// Only the fields consumed by log-scanning helpers (findMintAgentId, scanForFeedbackIndex).
// removed: true when the log was orphaned by a chain reorg — callers must skip these.
export type ReceiptLog = {
  address: `0x${string}`;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  removed?: boolean;
};
