# @concierge/aave-v3-mantle

Aave V3 Mantle action provider for the Concierge agent. Exposes 6 `ConciergeTool` actions with Zod schemas, viem-based execution, and ERC-8004 attestation hooks.

## Quickstart

```ts
import { createAaveV3MantleProvider } from '@concierge/aave-v3-mantle';

const provider = createAaveV3MantleProvider({ walletClient, chain: 'mantle-mainnet' });
// { txHash, attestationPayload }
const result = await provider.actions.supply.invoke({
  asset: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', // USDC
  amount: 1_000_000n, // 1 USDC
  onBehalfOf: '0xYourSmartAccount',
});
```

## Actions

| Action | Description |
|---|---|
| `supply` | Supply collateral, mint aTokens |
| `borrow` | Variable-rate borrow (requires E-Mode 1 for sUSDe collateral) |
| `repay` | Repay debt; `amount: 'max'` clears the full position |
| `withdraw` | Withdraw collateral; refuses if HF would drop below 1.5 |
| `setUserEMode` | Toggle E-Mode category (0=general, 1=sUSDe, 2=USDe) |
| `claimRewards` | Claim WMNT/USDC rewards from the Mantle Incentives Controller |

> **Load-bearing**: Always call `setUserEMode(1)` before the first borrow when sUSDe is the collateral — without it, `Pool.borrow()` returns 0 silently (sUSDe LTV=0 in general mode). The `borrow` action enforces this client-side and throws `ConciergeError('EModeNotEnabled')` if violated.
