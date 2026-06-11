# Mantle DEX Aggregation — Concierge Domain Knowledge

## What this is
The "swap" action provider. Concierge needs to convert any token to any other (USDC→USDT0, mETH→USDC for spending, USDe→sUSDe before deposit) on Mantle Mainnet, at best-execution price, with bounded slippage. We aggregate **four** Mantle-native venues — Merchant Moe (Trader-Joe-fork, LB), Agni Finance (Uniswap-V3-fork CLMM), FusionX (Uniswap-V3-fork CLMM), WOOFi (sPMM oracle-priced AMM) — plus optionally Li.Fi as a meta-aggregator fallback.

## Verified facts (with evidence)

### Mantle Mainnet (chain id 5000)

#### Merchant Moe (Trader Joe V2.2 fork)
Source: https://docs.merchantmoe.com/resources/contracts (fetched 2026-06-03)
| Contract | Address |
|---|---|
| MoeRouter (V1 AMM) | `0xeaEE7EE68874218c3558b40063c42B82D3E7232a` |
| MoeFactory | `0x5bef015ca9424a7c07b68490616a4c1f094bedec` |
| LBRouter (Liquidity Book v2.2) | `0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a` |
| LBFactory | `0xa6630671775c4EA2743840F9A5016dCf2A104054` |
| LBQuoter | `0x501b8AFd35df20f531fF45F6f695793AC3316c85` |
| MasterChef | `0xd4BD5e47548D8A6ba2a0Bf4cE073Cbf8fa523DcC` |

Verification: `cast call 0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a "getFactory()(address)" --rpc-url https://rpc.mantle.xyz` → `0xa6630671775c4EA2743840F9A5016dCf2A104054` ✓

#### Agni Finance (Uniswap V3 fork)
| Contract | Address | Verified via |
|---|---|---|
| SwapRouter | `0x319B69888b0d11cEC22caA5034e25FfFBDc88421` | `cast call ROUTER "factory()(address)"` → `0x25780dc8...` |
| Factory | `0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035` | `cast call FACTORY "owner()(address)"` → `0xD8A4...` |
| QuoterV2 | `0xc4aaDc921E1cdb66c5300Bc158a313292923C0cb` | VERIFIED: `cast call … "factory()(address)"` → `0x25780dc8...` ✓ |
| NonfungiblePositionManager | `0x218bf598D1453383e2F4AA7b14fFB9BfB102D637` | [UNVERIFIED — not needed for story-32] |

#### FusionX V3 (Algebra V3 fork — NOT Uniswap V3)
| Contract | Address |
|---|---|
| SwapRouter | `0x5989FB161568b9F133eDf5Cf6787f5597762797F` |
| Factory | `0x530d2766D1988CC1c000C8b7d00334c14B69AD71` |
| PoolDeployer | `0x8790c2C3BA67223D83C8FCF2a5E3C650059987b4` |
| QuoterV2 | `0x90f72244294E7c5028aFd6a96E18CC2c1E913995` |

Verification: `cast call 0x5989FB161568b9F133eDf5Cf6787f5597762797F "factory()(address)" --rpc-url https://rpc.mantle.xyz` → `0x530d2766...` ✓
`cast call 0x90f72244294E7c5028aFd6a96E18CC2c1E913995 "factory()(address)" --rpc-url https://rpc.mantle.xyz` → `0x530d2766...` ✓

NOTE: FusionX is an Algebra V3 fork, NOT a pure Uniswap V3 fork. Key Algebra differences:
- Dynamic fees (no fixed fee tiers like 500/3000/10000)
- `quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice)` — no fee param
- `factory()` on QuoterV2 returns factory address (verified above)

#### WOOFi V2 (sPMM)
| Contract | Address |
|---|---|
| WooPPV2 | `0x5520385bFcf07Ec87C4c53A7d8d65595Dff69FA4` |
| WooRouterV2 | `0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7` |

Verification: both have bytecode; WooPPV2 owner = `0x54Bd11A62f6cC41E40E231FA0B709482cFfD21ce` (WOO ops multisig).

#### Li.Fi Meta-Aggregator
| Contract | Address |
|---|---|
| LiFi Diamond (Mantle) | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Permit2Proxy | `0xBDfF0c1C8B0b779581C4aC3bA1F29667C366C56e` |

Verified via `https://li.quest/v1/chains` API response (id 5000, `diamondAddress` field).

### Mantle Sepolia (chain 5003)
None of these DEXes deploy a complete testnet stack reliably. **[UNVERIFIED — spec writer must decide]**: either (a) run a Mainnet fork against Anvil, or (b) ship swap as a thin wrapper around Li.Fi and mock locally.

### Common
- WMNT: `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` (18 decimals, verified)
- Native MNT must be wrapped before most router interactions.

## Key functions / ABI surface

### Agni / FusionX (Uniswap V3 ISwapRouter)
```solidity
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;            // 100/500/3000/10000 = 0.01%/0.05%/0.30%/1.00%
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96; // 0 = no limit
}
function exactInputSingle(ExactInputSingleParams) returns (uint256 amountOut);

struct ExactInputParams {
    bytes path;            // concat(tokenA, fee, tokenB, fee, tokenC) as packed bytes
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
}
function exactInput(ExactInputParams) returns (uint256 amountOut);
```
Quote via QuoterV2: `quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96)) returns (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)`.

### Merchant Moe LBRouter
```solidity
function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    Path memory path,       // {pairBinSteps[], versions[], tokenPath[]}
    address to,
    uint256 deadline
) returns (uint256 amountOut);

// V1 MoeRouter has the classic Uniswap V2 signatures (swapExactTokensForTokens with address[] path).
```
Quote via LBQuoter: `findBestPathFromAmountIn(address[] route, uint128 amountIn) returns (Quote memory)`.

### WOOFi WooRouterV2
```solidity
function swap(
    address fromToken,
    address toToken,
    uint256 fromAmount,
    uint256 minToAmount,
    address payable to,
    address rebateTo        // affiliate address, can be address(0)
) external payable returns (uint256 realToAmount);

function querySwap(address fromToken, address toToken, uint256 fromAmount)
    external view returns (uint256 toAmount);
```
WOOFi is oracle-priced (Chainlink + WOO's internal feeds). Best for large size on majors (USDC↔WETH/WMNT). No slippage on small trades — direct quote.

### Li.Fi (Meta-Aggregator)
HTTP API (preferred over direct contract calls — Li.Fi computes route off-chain):
```
GET https://li.quest/v1/quote
  ?fromChain=5000&toChain=5000
  &fromToken=<addr>&toToken=<addr>
  &fromAmount=<wei>
  &fromAddress=<smartAccount>
  &slippage=0.005    // 0.5%
  &order=CHEAPEST    // or FASTEST, SAFEST, RECOMMENDED
```
Returns `{transactionRequest: {to, data, value, gasLimit}}` — Concierge passes `to`/`data` straight into UserOp `callData`. The diamond verifies signatures and routes to the appropriate DEX adapter on-chain.

### Gotchas
- **Agni / FusionX deadlines**: pass `block.timestamp + 600` (10 min). Tighter = MEV-targeted reverts.
- **WOOFi rebateTo**: pass `address(0)` unless we're running a referral program.
- **Merchant Moe LB binSteps**: `1` (1bp), `5` (5bp), `15`, `20`, `25`, `50`, `100`. Quoter picks; don't hard-code.
- **V3 path encoding**: `bytes.concat(addr20, uint24fee, addr20)` — viem's `encodePacked` works. Wrong padding = "STF" revert.
- **Li.Fi `sendingAmount` minimum**: $1 effective. Below threshold the API returns 422.
- **Native MNT**: WooRouterV2 accepts `msg.value` on swap-from-MNT. V3 routers require WMNT wrap first.

## Integration pattern for Concierge

### Package: `@concierge/mantle-dex`
Aggregator strategy — every swap intent runs through `quoteAllVenues()`:

```ts
async function quoteAllVenues({ tokenIn, tokenOut, amountIn }) {
  const [agniQ, fusionxQ, mmQ, wooQ, lifiQ] = await Promise.allSettled([
    agni.quote(tokenIn, tokenOut, amountIn),
    fusionx.quote(tokenIn, tokenOut, amountIn),
    merchantMoe.quote(tokenIn, tokenOut, amountIn),
    woofi.querySwap(tokenIn, tokenOut, amountIn),
    lifi.quote(tokenIn, tokenOut, amountIn),
  ]);
  return [...].sort(byAmountOutDesc);
}
```
Pick venue with best `amountOut` net of (a) gas, (b) Concierge's static `slippage` buffer (default 50bp), (c) venue reliability score (last 100 ticks).

### Action types
- `swap.exactIn({tokenIn, tokenOut, amountIn, minAmountOut, recipient})`
- `swap.exactOut({tokenIn, tokenOut, amountOut, maxAmountIn, recipient})` (only Li.Fi supports this cleanly cross-venue)
- `swap.batch([...])` — atomic multi-hop using Li.Fi or a custom multicall

### Plan → Simulate → Propose → Execute
1. **Plan**: call `quoteAllVenues`. Concierge planner picks venue. Compute `minAmountOut = quote * (1 - slippageBps/10000)`.
2. **Simulate**: `eth_call` against forked Mantle RPC with the encoded swap calldata. Reject if revert OR if `amountOut < minAmountOut * 0.995` (sandwich attack guard).
3. **Propose**: build UserOp. Session key scoped to the chosen router's `swapExactTokensForTokens` / `exactInputSingle` / `swap` 4-byte selector ONLY. Concierge must whitelist all 4 router addresses in session-key policy upfront.
4. **Execute**: send. Read `amountOut` from the receipt's `Swap` event (every router emits one).

### ERC-8004 attestation
```json
{
  "schema": "concierge.dex.swap.v1",
  "chain": 5000,
  "venue": "agni" | "fusionx" | "merchantMoe" | "woofi" | "lifi",
  "router": "0x319B69...",
  "tokenIn": "0x...",
  "tokenOut": "0x...",
  "amountIn": "1000000",
  "amountOut": "999742",
  "slippageBps": 26,
  "quotedOut": "999800",
  "txHash": "0x...",
  "ts": 1717400000
}
```
`slippageBps = (quotedOut - amountOut) * 10000 / quotedOut` — a real-time slippage report on every swap. Useful reputation signal.

### Error handling
| Error | Action |
|---|---|
| Quote API fails (Li.Fi 5xx) | Drop Li.Fi; route via on-chain quoters only |
| All quoters revert | Pause swap action provider; alert |
| `amountOut < minAmountOut` revert | Bump slippage 25bp, retry once, then fail |
| Slippage > 200bp observed | Mark venue degraded for 10 min |
| Native MNT swap on V3 router (no wrap) | Auto-prepend `WMNT.deposit{value}` call |

## Mechanics / mental model

### Merchant Moe — Liquidity Book (LB v2.2)
Trader Joe's "bin-based" AMM. LPs deposit into discrete price bins (binSteps in bps). Concentrates liquidity like V3 but with **zero slippage within a bin** — different math than CLMM. For stable pairs (USDC/USDT0) bins are 1bp wide → essentially zero-slip on small swaps. For volatile (MNT/USDC) bins are 25-100bp.

### Agni Finance & FusionX — Uniswap V3 clones
Standard CLMM: liquidity in ranges, fees in 1bp/5bp/30bp/100bp tiers. Best for stable-stable (5bp tier) and majors (30bp). Their TVL is the secondary signal — Agni historically deeper on stable pairs, FusionX deeper on MNT pairs. Concierge does not rebalance — just consumes quotes.

### WOOFi — sPMM (oracle-priced)
WOOFi prices off Chainlink + their internal feed, then quotes via a synthetic proactive market-maker formula. No LP slippage on small trades. **Best for large trades on majors** (WETH/USDC, BTC/USDC, MNT/USDC). Falls behind on long-tail tokens (sUSDe, USDe, USDY) where feeds don't exist.

### Li.Fi
Off-chain DEX aggregator with on-chain settlement diamond. Internally evaluates ~30 sources (including the four above plus Stargate, OKX DEX, Squid, etc.). Concierge uses Li.Fi for: (a) routes our four-venue scan misses, (b) cross-chain swap-and-bridge in one UserOp (see `lifi-bridge.md`), (c) fallback when on-chain quoters revert.

### Sandwich resistance
Concierge's slippage default = 50bp. With smart-account batching, the swap is part of a larger UserOp (e.g. bridge-then-swap-then-supply) — atomic via 4337 bundler. MEV searchers can't sandwich the swap leg directly; they can only sandwich the whole UserOp, which requires reordering bundler txs (high-cost for the value Concierge moves).

## Risks + edge cases

1. **Stale quotes**: any cached quote > 6 seconds → re-quote. Block time on Mantle is ~2s.
2. **Long-tail tokens**: sUSDe, USDY, mETH, cmETH have shallow pools — Li.Fi route may fail. Concierge must (a) check if Li.Fi returns a route, (b) if not, fall back to a 2-hop via USDC.
3. **Venue downtime**: any single router pause cascades to a degraded swap provider. Concierge marks the venue with a 10-min cooldown after 3 consecutive failures.
4. **Router upgrade**: Agni / FusionX are forks — they could deploy new routers and deprecate old ones. Concierge spec must include a "refresh router addresses from Li.Fi `/v1/connections` weekly" task.
5. **Fee-on-transfer tokens**: USDe and sUSDe are NOT fee-on-transfer. None of Mantle's listed Aave reserves are. Safe to assume `balanceOf` deltas match `amountOut`.
6. **Mantle MNT precompile**: WMNT wrap costs ~30k gas; un-wrap ~25k. Concierge gas estimate must include this.

## Reference URLs
- Merchant Moe docs: https://docs.merchantmoe.com/resources/contracts.md
- Agni Finance: https://agni.finance (docs at https://docs.agni.finance)
- FusionX: https://fusionx.finance
- WOOFi docs: https://learn.woo.org
- Li.Fi API: https://docs.li.fi/li.fi-api/li.fi-api
- Li.Fi diamond on Mantle: https://mantlescan.xyz/address/0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE

## Open questions for spec writer
1. **Default slippage**: 50bp? Per-tier (10bp stable-stable, 50bp stable-volatile, 100bp long-tail)?
2. **Aggregator order**: hard-prefer Li.Fi (off-chain compute, more routes) or hard-prefer on-chain quoters (no API dependency)? Recommend: Li.Fi for >$100 trades, on-chain quote scan for <$100.
3. **Session key scope**: 4 routers × 1-2 selectors each = 5-8 selectors total. Enumerate.
4. **Native MNT auto-wrap**: should action provider auto-wrap on swap-from-MNT, or require pre-wrapped input?
5. **Multicall**: Mantle Permit2Proxy exists. Use it for batching approve+swap or use 4337 batchable execute? Recommend the latter — simpler.
6. **Quote staleness**: 6s sufficient? Or 2s (one block)?
