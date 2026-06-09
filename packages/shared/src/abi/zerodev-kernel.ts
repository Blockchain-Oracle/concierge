// ZeroDev Kernel v3.1 minimal ABI per ADR-010.
//
// Verified against zerodevapp/kernel v3.1 source: only `execute(bytes32 mode, bytes calldata)`
// exists. Batching is encoded into `executionCalldata` via the ERC-7579 mode word —
// there is NO `executeBatch` entrypoint (Safe MultiSend pattern, NOT Kernel).
// Story-50 will land a `BATCH_EXEC_MODE` constant + `encodeBatchCalls()` helper here
// when the session-key orchestration goes in.

import { type Abi, parseAbi } from 'viem';

export const kernelAbi = parseAbi([
  'function execute(bytes32 mode, bytes executionCalldata)',
]) satisfies Abi;
