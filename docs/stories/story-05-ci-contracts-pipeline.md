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
- `contracts/.slither.config.json` — NEW — Slither config (filter `lib/|out/|cache/|broadcast/|test/`; exclude informational/low/optimization; fail on HIGH severity; `solc_remaps` matching the @-prefixed canonical remappings).
- `contracts/aderyn.toml` — NEW — Aderyn config (ready-to-use; NOT wired into CI in story-05 because Cyfrin doesn't ship an official Aderyn GitHub Action yet — Slither covers the same ground via its official action. File is kept ready so a one-step CI bump lights Aderyn up when an official action ships or we vendor the binary).

Spec correction folded in (2026-06-09 PR #7): coverage gate at 80% is **informational only** in story-05 — `forge coverage --report summary` reports `100.00% (0/0)` on today's empty `src/`. The hard gate activates when story-10+ lands real source. The `forge coverage` step still runs (exercises the toolchain end-to-end), it just doesn't block.

---

## Acceptance criteria (BDD)

```
Given .github/workflows/ci.yml has a contracts job
When `node -e "const yaml = require('js-yaml'); const c = yaml.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log(Object.keys(c.jobs).includes('contracts'))"` runs
Then output is `true`

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

# Slither + Aderyn configs (Aderyn config ready-to-use but NOT yet wired
# into CI — no official Cyfrin/aderyn-action available 2026-06-09)
test -f contracts/.slither.config.json
test -f contracts/aderyn.toml
grep -q "fail_on" contracts/.slither.config.json
grep -q "fail-on-high" contracts/aderyn.toml

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
