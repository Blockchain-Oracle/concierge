# Story — `@concierge/shared` package bootstrap

**ID:** story-20-shared-package-bootstrap
**Epic:** Epic E2 — Shared SDK Core
**Depends on:** story-04-ci-typescript-pipeline
**Estimate:** ~45min
**Status:** PENDING

---

## User story

**As a** Concierge package author
**I want to** import addresses, ABI bindings, and shared types from a single `@concierge/shared` package
**So that** no contract address or ABI is duplicated across the codebase

---

## File modification map

- `packages/shared/package.json` — NEW — `name: "@concierge/shared"`, version `0.0.0`, exports map, type `module`, `peerDependencies.viem` per ADR-018, `"files":["dist","src"]`, build script via tsup
- `packages/shared/tsconfig.json` — UPDATE (created in story-02) — declare `outDir: dist`, `composite: true`
- `packages/shared/tsconfig.build.json` — NEW — separate build tsconfig (`composite: false`, `emitDeclarationOnly: true`, `ignoreDeprecations: "6.0"`) so tsup's dts pipeline doesn't trip on project-reference strictness
- `packages/shared/tsup.config.ts` — NEW — ESM-only, `dts: { resolve: true }`, target `node22`, points at `tsconfig.build.json` per ADR-018
- `packages/shared/src/index.ts` — NEW — barrel exports (named only, no `export *`)
- `packages/shared/src/addresses.ts` — NEW — `ADDRESSES.mantleMainnet` + `ADDRESSES.mantleSepolia` (each with: `aave.pool`, `aave.oracle`, `aave.addressesProvider`, `aave.protocolDataProvider`, `tokens.sUSDe`, `tokens.USDC`, `tokens.USDe`, `tokens.WMNT`, `tokens.WETH`, `tokens.USDY`, `tokens.mETH`, `erc8004.identityRegistry`, `erc8004.reputationRegistry`, `lifi.diamond`, `mantleDex.merchantMoe.lbRouter`, `mantleDex.agni.factory`); recursive `deepFreeze` at runtime; `addressesFor` overloads narrowing per chain id with `satisfies never` exhaustiveness; `SEPOLIA_PENDING_ADDRESS_SLOTS` lockbox so future stories cannot silently regress a populated address back to zero
- `packages/shared/src/chains.ts` — NEW — viem chain configs for Mantle Mainnet + Sepolia; `chainFor(chainId: EvmChainId)` uses the shared type (not an inline literal union) so adding a third chain becomes a compile error here
- `packages/shared/src/types.ts` — NEW — shared types: `EvmChainId` (5000 | 5003 literal union), `AgentId` (`unique symbol` brand with `agentId()` constructor + `isAgentId()` guard validating `^agent_[0-9a-f]{32}$`), `TickPhase` (6-arm union — `plan | simulate | propose | decide | execute | record` per architecture.md repo-structure + story-60 routeModelForPhase), `ActionKind` (11-arm), `ProviderName` (7-arm), `Hex`, `Address` (viem re-exports). SOURCE OF TRUTH banner — downstream packages MUST import these (no local redeclaration)
- `packages/shared/src/index.test.ts` — NEW — vitest invariant suite covering: format regex + EIP-55 checksum on every Mainnet entry (WETH vanity exempt per `research/concierge/03-providers/aave-v3-mantle.md:34`); pinned-value `it.each` for every Mainnet address (16) + Sepolia ERC-8004 (2); deep-freeze runtime test; Sepolia pending-slot lockbox; negative-path tests for `addressesFor` + `chainFor`; `agentId()` happy + sad path; `expectTypeOf` type-level contracts for every public type union

---

## Acceptance criteria (BDD)

```
Given `@concierge/shared` package exists
When `node -e "const pkg = require('./packages/shared/package.json'); console.log(pkg.name)"` runs
Then output is "@concierge/shared"

Given addresses are exported
When the test file runs via `pnpm test packages/shared/src/index.test.ts`
Then ≥ 12 test cases pass asserting every address matches /^0x[a-fA-F0-9]{40}$/

Given ERC-8004 addresses are correct (per docs/architecture.md ADR + research/concierge/03-providers/erc8004.md)
When the test asserts `ADDRESSES.mantleMainnet.erc8004.identityRegistry`
Then the value equals `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`

Given Aave V3 Mantle Pool address is correct
When the test asserts `ADDRESSES.mantleMainnet.aave.pool`
Then the value equals `0x458F293454fE0d67EC0655f3672301301DD51422`

Given Li.Fi Diamond address is correct
When the test asserts `ADDRESSES.mantleMainnet.lifi.diamond`
Then the value equals `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`

Given typecheck runs on the package
When `pnpm run typecheck` runs at root
Then exit code is 0
```

---

## Shell verification

```bash
test -f packages/shared/package.json
test -f packages/shared/src/index.ts
test -f packages/shared/src/addresses.ts
test -f packages/shared/src/chains.ts
test -f packages/shared/src/types.ts
test -f packages/shared/src/index.test.ts

# Package name correct
node -e "
  const pkg = require('./packages/shared/package.json');
  if (pkg.name !== '@concierge/shared') process.exit(1);
"

# Tests pass with ≥ 12 cases
pnpm test packages/shared/src/index.test.ts --reporter=verbose 2>&1 | grep -E "(✓|PASS)" | wc -l | awk '$1 >= 12 {exit 0} {exit 1}'

# Verified ERC-8004 + Aave + Li.Fi addresses
bun -e "
  import { ADDRESSES } from './packages/shared/src/addresses.ts';
  if (ADDRESSES.mantleMainnet.erc8004.identityRegistry.toLowerCase() !== '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432') process.exit(1);
  if (ADDRESSES.mantleMainnet.aave.pool.toLowerCase() !== '0x458f293454fe0d67ec0655f3672301301dd51422') process.exit(1);
  if (ADDRESSES.mantleMainnet.lifi.diamond.toLowerCase() !== '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae') process.exit(1);
" || exit 1
```

---

## Notes for coding agent

- Source of truth for addresses: `research/concierge/03-providers/*.md` (each provider doc has verified addresses).
- The addresses are FROZEN — they were verified via on-chain cast calls 2026-06-03. Do NOT modify without a verification pass.
- Sepolia mock addresses are filled in by `scripts/write-addresses.mjs` (story-190) after the deploy. Leave Sepolia values as `0x0000...0000` placeholders for now with a comment.
- Mantle Sepolia chain id is `5003`; Mainnet is `5000`. The viem `mantle` chain ships with mainnet config; Sepolia needs a custom definition (use `defineChain` from viem).
- Address constants are exported as `const` with `as const` for type narrowing. Use `Hex` and `Address` types from viem.
- The barrel export in `index.ts` re-exports everything from `addresses.ts`, `chains.ts`, `types.ts` so consumers import as `from '@concierge/shared'` only.
