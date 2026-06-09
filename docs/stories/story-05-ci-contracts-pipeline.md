# Story — CI: Foundry contracts pipeline

**ID:** story-05-ci-contracts-pipeline
**Epic:** Epic E0 — Foundation
**Depends on:** story-03-foundry-init-and-remappings
**Estimate:** ~30min
**Status:** PENDING

---

## User story

**As a** Concierge contracts engineer
**I want to** `forge build + forge test + forge coverage` runs in CI on every push affecting contracts/
**So that** contract regressions are caught before merge

---

## File modification map

- `.github/workflows/contracts.yml` — NEW (was: UPDATE ci.yml). Separate workflow file because per-job `paths:` filters are unsupported in GH Actions; workflow-level path filter is the canonical way to skip the contracts pipeline on TS-only PRs. Contains: `contracts` job (Foundry toolchain + install-deps + `forge fmt --check` + `forge build --sizes` + `forge test -vvv` + `forge coverage --report summary`). `contracts-security` job (PR-only): Slither via `crytic/slither-action@v0.4.2` with `fail-on: high`. Top-level path filter on `contracts/**` + `.github/workflows/contracts.yml`.
- `contracts/.slither.config.json` — NEW — Slither config (filter `lib/|out/|cache/|broadcast/|test/`; exclude informational/low/optimization; `solc_remaps` matching the @-prefixed canonical remappings). Severity gate lives in workflow `with: fail-on: high` (single source of truth — `fail_on` in config dropped per type-design + simplification on PR #7).
- `contracts/src/Placeholder.sol` — NEW (post-merge PR #7 follow-up). Real source so the Slither + forge coverage gates run against analyzable code instead of vacuous-green on empty src/. Story-10 (ConciergeRegistry base) replaces this file. The post-merge re-review of PR #7 caught a cascade of vacuous-green silent-failures from the original conditional-skip pattern (`if: count != '0'` on the Slither step is the same branch-protection bypass shape as the original PR-only `if:` it replaced); the Placeholder pattern removes the conditional entirely.
- ~~`contracts/aderyn.toml` — NEW~~ — DROPPED 2026-06-09 in PR #7 follow-up. Three reviewers converged (simplification + silent-failure + type-design): a config file that declares semantics (`fail-on-high`) the CI never enforces is worse than absent — it implies a gate that doesn't exist. When Cyfrin ships an official Aderyn action (or we vendor the binary post-hackathon), `aderyn init` regenerates a default `aderyn.toml` in seconds. Slither covers the same HIGH-severity static analysis ground.

Spec correction folded in (2026-06-09 PR #7): coverage gate at 80% is **informational only** in story-05 — `forge coverage --report summary` reports `100.00% (0/0)` on today's empty `src/`. The hard gate activates when story-10+ lands real source. The `forge coverage` step still runs (exercises the toolchain end-to-end), it just doesn't block.

---

## Acceptance criteria (BDD)

```
Given .github/workflows/contracts.yml exists with a contracts job (separate file because GH Actions per-job `paths:` is unsupported — see spec patch in file modification map)
When `grep -qE "^\s*contracts:" .github/workflows/contracts.yml` runs
Then exit code is 0

Given the contracts job uses Foundry
When grep checks the workflow
Then it contains "foundry-rs/foundry-toolchain"

Given the contracts job runs forge fmt --check
When grep checks the workflow
Then it contains "forge fmt --check"

Given the contracts job runs forge build + test
When grep checks the workflow
Then it contains "forge build" AND "forge test"

Given the contracts job runs coverage
When grep checks the workflow
Then it contains "forge coverage"

Given the path filter is set
When grep checks the contracts job triggers
Then it includes "paths:" with `contracts/**` (so the heavy job only runs when contracts change)
```

---

## Shell verification

```bash
# Workflow has contracts job (in the dedicated contracts.yml file — see
# spec correction above; per-job paths: filters unsupported in GH Actions)
test -f .github/workflows/contracts.yml
grep -qE "^\s*contracts:" .github/workflows/contracts.yml

# Foundry toolchain
grep -q "foundry-rs/foundry-toolchain" .github/workflows/contracts.yml

# All required forge commands
grep -q "forge fmt --check" .github/workflows/contracts.yml
grep -q "forge build" .github/workflows/contracts.yml
grep -q "forge test" .github/workflows/contracts.yml
grep -q "forge coverage" .github/workflows/contracts.yml

# Slither config (Aderyn dropped 2026-06-09 — see file modification map)
test -f contracts/.slither.config.json
# Slither severity gate lives in workflow `with: fail-on: high` (single
# source of truth per type-design + simplification on PR #7).
grep -q "fail-on: high" .github/workflows/contracts.yml
# Smoke test for the config (story-01/02 precedent: every enforcement
# config gets a behavioral test).
test -f scripts/test-slither-config.mjs

# Path filter present (saves CI minutes on TS-only PRs)
grep -q "contracts/\*\*" .github/workflows/contracts.yml
```

---

## Notes for coding agent

- Inherits the top-level `concurrency` group + `cancel-in-progress: true` from story-04's ci.yml (single workflow, multiple jobs).
- The `contracts` job uses `timeout-minutes: 15` (forge test against Mainnet fork can take longer than the TS test matrix).
- `permissions: { contents: read }` at job level matches story-04's least-privilege pattern.
- Use `foundry-rs/foundry-toolchain@v1` — official action.
- Path filter the contracts job so it skips when only TS changes (saves CI minutes):
  ```yaml
  on:
    push:
      paths:
        - 'contracts/**'
        - '.github/workflows/ci.yml'
    pull_request:
      paths:
        - 'contracts/**'
  ```
- `forge install` step runs `bash contracts/scripts/install-deps.sh` from story-03.
- `forge coverage --report summary` outputs to stdout; gate at 80% via `awk` parsing:
  ```bash
  cov=$(forge coverage --report summary | awk '/^Total/{print $NF}' | tr -d '%')
  [ "${cov%.*}" -ge 80 ] || exit 1
  ```
- Slither + Aderyn run in a separate job, also path-filtered. Fail on HIGH severity findings only (LOW/MEDIUM is advisory).
- Set `working-directory: contracts` on all forge steps so paths resolve correctly.
