# Story — CI: TypeScript pipeline

**ID:** story-04-ci-typescript-pipeline
**Epic:** Epic E0 — Foundation
**Depends on:** story-01-biome-and-loc-enforcement, story-02-typescript-config
**Estimate:** ~45min
**Status:** PENDING

---

## User story

**As a** Concierge contributor
**I want to** GitHub Actions runs `pnpm install + biome check + tsc + test + build` on every push and PR
**So that** broken code never reaches main and merges are gated on green CI

---

## File modification map

- `.github/workflows/ci.yml` — NEW — TypeScript jobs: `lint`, `typecheck`, `loc-cap`, `test` (matrix per package). Top-level features:
  - `on: push: { branches: ['**'] }` + `on: pull_request: { branches: [main] }` + `workflow_dispatch:`
  - `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`
  - `permissions: { contents: read, pull-requests: read }` (explicit)
  - Per-job `timeout-minutes` (lint: 5, typecheck: 5, loc-cap: 2, test: 15)
  - `env: { PNPM_VERSION: "10", NODE_VERSION: "22" }` (pinned to match `packageManager: pnpm@10.33.0` in `package.json`)
- `.github/dependabot.yml` — NEW — weekly updates for npm + GitHub Actions
- `CONTRIBUTING.md` — NEW — short contributor flow (clone, install, branch, commit, PR)

The job matrix (placeholder shape; per-package shards activate as `@concierge/*` packages with real `test` scripts land in story-20+):
```yaml
test:
  strategy:
    fail-fast: false
    matrix:
      # Single shard today — no @concierge/* package has a test script yet.
      # Story-20+ expands this list as real packages arrive
      # (e.g. sdk, shared, providers-aave-v3-mantle, ...).
      package: [_workspace_]
```
The single shard runs `pnpm -r test` workspace-wide. Once the matrix expands, each shard runs `pnpm run --filter=@concierge/<pkg> test --reporter=verbose --coverage` and coverage uploads as an artifact.

---

## Acceptance criteria (BDD)

```
Given .github/workflows/ci.yml exists with explicit lint + typecheck + loc-cap + test jobs
When `yq '.jobs | keys' .github/workflows/ci.yml` runs
Then output includes "lint", "typecheck", "loc-cap", "test"

Given the workflow uses pnpm + Node
When grep checks the file
Then it contains "pnpm/action-setup" AND "actions/setup-node" (setup-node@v4 with `cache: pnpm` is the canonical 2026 pattern)

Given the workflow has concurrency control
When grep checks the file
Then it contains "concurrency:" AND "cancel-in-progress: true"

Given each job has a timeout
When `yq '.jobs.*.timeout-minutes' .github/workflows/ci.yml` runs
Then every value is a positive integer (no missing timeouts)

Given the workflow has explicit permissions
When grep checks the file
Then it contains "permissions:" with "contents: read" at minimum

Given workflow_dispatch is enabled
When grep checks the file
Then it contains "workflow_dispatch:"

Given the workflow runs on push and PR
When grep checks the trigger
Then it contains "push:" and "pull_request:" with PR scoped to main

Given the workflow runs Biome
When grep checks the steps
Then it contains "pnpm run check" or "biome check"

Given the workflow runs typecheck
When grep checks the steps
Then it contains "tsc -b" or "pnpm run typecheck"

Given the workflow runs tests
When grep checks the steps
Then it contains "pnpm run test" or "vitest"

Given Dependabot is configured
When `cat .github/dependabot.yml` runs
Then output contains "npm" and "github-actions"
```

---

## Shell verification

```bash
test -f .github/workflows/ci.yml
test -f .github/dependabot.yml
test -f CONTRIBUTING.md

# CI uses pnpm + Node 22 (canonical 2026 pattern)
grep -q "pnpm/action-setup" .github/workflows/ci.yml
grep -q "actions/setup-node" .github/workflows/ci.yml
grep -q "cache: pnpm" .github/workflows/ci.yml

# Triggers on push + PR
grep -qE "^\s*push:" .github/workflows/ci.yml
grep -qE "^\s*pull_request:" .github/workflows/ci.yml

# All four required steps present
grep -qE "(pnpm run check|biome check)" .github/workflows/ci.yml
grep -qE "(tsc -b|pnpm run typecheck)" .github/workflows/ci.yml
grep -qE "(pnpm run test|vitest)" .github/workflows/ci.yml
grep -q "pnpm run build" .github/workflows/ci.yml

# LOC cap job present + invokes the script from story-01
grep -qE "^\s*loc-cap:" .github/workflows/ci.yml
grep -q "scripts/check-file-loc.mjs" .github/workflows/ci.yml

# Concurrency + cancel-in-progress
grep -q "concurrency:" .github/workflows/ci.yml
grep -q "cancel-in-progress: true" .github/workflows/ci.yml

# Every job has timeout-minutes
test "$(yq '.jobs.*.timeout-minutes // null' .github/workflows/ci.yml | grep -c null)" -eq 0

# Explicit permissions block
grep -q "permissions:" .github/workflows/ci.yml
grep -q "contents: read" .github/workflows/ci.yml

# workflow_dispatch enabled (manual re-runs)
grep -q "workflow_dispatch:" .github/workflows/ci.yml

# Test matrix runs per package
grep -q "matrix:" .github/workflows/ci.yml
grep -q "package:" .github/workflows/ci.yml

# Dependabot configured
grep -q "package-ecosystem: \"npm\"" .github/dependabot.yml
grep -q "package-ecosystem: \"github-actions\"" .github/dependabot.yml
```

---

## Notes for coding agent

- Use `pnpm/action-setup@v6` (with `version: 10`) for pnpm and `actions/setup-node@v6` (with `node-version: 22`, `cache: pnpm`) for Node. Verified current as of 2026-06-09 via the GitHub API releases endpoint. The `cache: pnpm` option on setup-node@v6 handles pnpm-store caching automatically — no manual `actions/cache@v4` configuration needed. (Spec previously suggested v4; bumped because the actions/* ecosystem advanced to v6 / v7.)
- **SEPARATE jobs, not a single matrix-task job.** Reference pattern: `find-evil/.github/workflows/ci.yml` has 8 gated jobs as required-status-checks for branch protection. Splitting lint/typecheck/loc-cap/test lets a typecheck failure not cancel the lint run — important for fast feedback on PRs.
- **`fail-fast: false`** on the test matrix so all packages report their results even if one fails.
- The workflow runs against Ubuntu-24.04 (pinned, not `-latest` — find-evil rationale: `-latest` floats, reproducibility matters for the audit trail).
- The contracts job lives in `story-05-ci-contracts-pipeline` (separate Foundry toolchain).
- Run `pnpm install --frozen-lockfile` (CI mode — fails if lockfile is stale).
- **Concurrency:** `group: ci-${{ github.ref }}` + `cancel-in-progress: true` — when a new commit lands on a branch, the in-flight CI for the prior commit is cancelled (saves runner minutes + gives latest result faster).
- **Permissions:** explicit `contents: read` per least-privilege; if any job needs more (e.g., `packages: write` for GHCR push), it overrides at the job level. Reference: find-evil ci.yml lines 58-61.
- **Timeouts** per job prevent runaway runs: lint/typecheck/loc-cap ≤ 5min; test up to 15min for the largest provider shard.
- **workflow_dispatch** enables manual re-runs without an empty commit. Reference: find-evil ci.yml line 56.
- Dependabot weekly updates keep dependencies fresh without nag-storm.
- Branch protection (configure separately on the GitHub side) makes `lint`, `typecheck`, `loc-cap`, `test`, `contracts` (story-05), `security` (story-07) required-status-checks. Renaming jobs without updating the rule breaks protection — document at the top of ci.yml.
- (Future extension) `scripts/coverage-gate.mjs` for per-package floors (≥80% on `packages/sdk/`, `packages/providers/*/`). Add after first stories ship with real tests. Reference: `find-evil/scripts/coverage_gate.py`.
