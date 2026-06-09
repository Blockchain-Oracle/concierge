# Story — Foundry init + remappings (NO Chainlink)

**ID:** story-03-foundry-init-and-remappings
**Epic:** Epic E0 — Foundation
**Depends on:** story-00-monorepo-scaffold
**Estimate:** ~30min
**Status:** PENDING

---

## User story

**As a** Concierge contracts engineer
**I want to** initialize Foundry at `contracts/` with the right remappings (OZ v5 + Aave V3 Origin) and explicitly NO Chainlink
**So that** all contracts compile against verified canonical sources without unused dependencies

---

## File modification map

- `contracts/foundry.toml` — NEW — solc 0.8.26, optimizer enabled (200 runs), fmt config, fuzz runs=256, invariant runs=256, `[rpc_endpoints]` for `mantle_mainnet` + `mantle_sepolia`, `[etherscan]` with Mantle Mainnet + Sepolia API config
- `contracts/remappings.txt` — NEW — OpenZeppelin v5.1 + Aave V3 Origin + forge-std mappings. **Explicitly NO Chainlink** (per ADR-008: no direct Chainlink feeds on Mantle; we use `IAaveOracle` via Aave V3 periphery).
- `contracts/lib/.gitkeep` — NEW (Foundry submodules)
- `contracts/.gitignore` — NEW — `out/`, `cache/`, `broadcast/`, `lib/`
- `contracts/src/.gitkeep` — NEW (real contracts arrive in story-10)
- `contracts/test/.gitkeep` — NEW
- `contracts/script/.gitkeep` — NEW
- `contracts/scripts/install-deps.sh` — NEW — runs `forge install` for OpenZeppelin Contracts v5.1.0, Aave V3 Origin, forge-std (called by CI + dev setup). **No Chainlink install per ADR-008.**

---

## Acceptance criteria (BDD)

```
Given Foundry is installed locally
When `forge --version` runs
Then exit code is 0

Given contracts/foundry.toml exists with solc 0.8.26
When `node -e "
  const fs = require('fs');
  const t = fs.readFileSync('contracts/foundry.toml','utf8');
  if (!t.includes('solc = \"0.8.26\"') && !t.includes(\"solc = '0.8.26'\")) process.exit(1);
"` runs
Then exit code is 0

Given contracts/remappings.txt exists
When grep checks the file
Then it contains "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" AND "@aave/=lib/aave-v3-origin/src/contracts/" AND it does NOT contain "chainlink" (case-insensitive). (Spec patched 2026-06-09 per type-design reviewer on PR #6: dual aliases dropped — keeping only the `@`-prefixed upstream-canonical form, since `openzeppelin-contracts/` + `@openzeppelin/contracts/` two-way aliasing invites inconsistent import styles across stories.)

Given the install-deps script exists
When `bash contracts/scripts/install-deps.sh` runs in a fresh clone
Then `contracts/lib/openzeppelin-contracts` + `contracts/lib/aave-v3-origin` + `contracts/lib/forge-std` exist

Given Foundry is set up
When `cd contracts && forge build` runs (with no contracts in src/ yet; test/Smoke.t.sol exercises the toolchain)
Then exit code is 0

Given the Smoke.t.sol toolchain test exists
When `cd contracts && forge test` runs
Then exit code is 0 with 2 passing tests (test_forgeStdIsWired + test_vmCheatcodesExecute) — validates that forge-std remap resolves, solc 0.8.26 compiles, shanghai EVM evaluates, and `vm.warp` cheatcode executes
```

---

## Shell verification

```bash
test -f contracts/foundry.toml
test -f contracts/remappings.txt
test -f contracts/scripts/install-deps.sh
test -d contracts/src
test -d contracts/test
test -d contracts/script

# solc 0.8.26 pinned
grep -qE "solc\s*=\s*['\"]0\.8\.26['\"]" contracts/foundry.toml

# OZ + Aave V3 Origin remappings present (upstream-canonical @-form only)
grep -q "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" contracts/remappings.txt
grep -q "@aave/=lib/aave-v3-origin/src/contracts/" contracts/remappings.txt

# NO Chainlink dep installed (per ADR-008). Skip comment lines (`#`) so
# the script can document the no-chainlink rationale without tripping
# this grep — only `forge install` lines (or any non-comment) matter.
! grep -iq "chainlink" contracts/remappings.txt
! grep -vE "^\s*#" contracts/scripts/install-deps.sh | grep -iq "chainlink"

# install-deps script is executable
test -x contracts/scripts/install-deps.sh

# Foundry builds cleanly (empty src + Smoke.t.sol in test/)
cd contracts && forge build
test $? -eq 0

# forge test passes Smoke.t.sol (toolchain wiring validation)
cd contracts && forge test
test $? -eq 0
```

---

## Notes for coding agent

- Per ADR-008: ABSOLUTELY NO Chainlink install. The `IAaveOracle` interface (`getAssetPrice(address)`) is in Aave V3 periphery, which IS installed via `aave-v3-origin`.
- OpenZeppelin Contracts v5.1.0 — pin the tag exactly. v5 uses custom errors not strings (we benefit from this).
- Aave V3 Origin is the canonical V3.6 repo (not the old `aave-v3-core`); it includes both core + periphery.
- forge-std for `Test.t.sol`, `Script.s.sol`, cheatcodes.
- Foundry `fmt` config (in `foundry.toml`) keeps Solidity formatting consistent with TS Biome config.
- `[rpc_endpoints]` section enables `--rpc-url mantle_mainnet` shorthand in scripts (reads from env `MANTLE_RPC_URL` / `MANTLE_SEPOLIA_RPC_URL`).
- `[etherscan]` section enables `--verify --etherscan-api-key` against Mantle Mainnet + Sepolia explorers (`mantlescan.xyz`).
