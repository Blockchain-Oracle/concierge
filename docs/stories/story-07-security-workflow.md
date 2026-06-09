# Story — Security workflow (gitleaks + trivy + osv-scanner + nightly cron)

**ID:** story-07-security-workflow
**Epic:** Epic E0 — Foundation
**Depends on:** story-04-ci-typescript-pipeline, story-06-husky-precommit-hooks
**Estimate:** ~30min
**Status:** PENDING

---

## User story

**As a** Concierge maintainer
**I want to** a dedicated security workflow runs gitleaks + trivy fs-scan + osv-scanner on every PR and nightly at 03:00 UTC
**So that** secrets, vulnerable dependencies, and known CVEs surface before merge — not after a public deploy

---

## File modification map

- `.github/workflows/security.yml` — NEW — three jobs running in parallel (each with `timeout-minutes: 5`):
  - `gitleaks` — **gitleaks MIT-licensed binary** (NOT `gitleaks/gitleaks-action`; that action ships under a commercial Gitleaks LLC license requiring per-org payment for organization repos). Workflow downloads the pinned binary via `curl + tar`, runs `gitleaks detect --config .gitleaks.toml --redact --no-banner -v` with `fetch-depth: 0` for full history scan. Same binary version (`8.30.1`) pinned in story-06's pre-commit hook + CONTRIBUTING manual-bump checklist. Spec patched 2026-06-09 (gitleaks-action@v3 is the current commercial version; binary stays MIT).
  - `trivy` — `aquasecurity/trivy-action@v0.36.0` with `scan-type: fs`, `scan-ref: '.'`, `severity: 'CRITICAL,HIGH'`, `exit-code: '1'`, `trivyignores: '.trivyignore'`, `ignore-unfixed: 'false'`.
  - `osv-scanner` — `google/osv-scanner-action@v2.3.8` with `scan-args: --skip-git --recursive ./` (spec said `@v1`; v2 is the current major). Reads `pnpm-lock.yaml` + `package.json` + Foundry `contracts/lib/*` manifests against the OSV database.
- `.gitleaks.toml` — UPDATE (created in story-06) — add additional fingerprint allowlist for known-safe test fixtures
- `.trivyignore` — NEW — empty placeholder (no current CVEs to ignore); document the format in a top comment

---

## Acceptance criteria (BDD)

```
Given .github/workflows/security.yml exists
When `yq '.jobs | keys' .github/workflows/security.yml` runs
Then output includes "gitleaks", "trivy", "osv-scanner"

Given the security workflow has triggers
When grep checks the file
Then it contains "push:" AND "pull_request:" AND "schedule:" AND "workflow_dispatch:"

Given the schedule is nightly
When grep checks the cron
Then the file contains `cron: '0 3 * * *'` (03:00 UTC)

Given each job has a timeout
When `yq '.jobs.*.timeout-minutes' .github/workflows/security.yml` runs
Then every value is ≤ 5

Given the workflow has concurrency control
When grep checks the file
Then it contains "concurrency:" AND "cancel-in-progress: true" AND "group: security-${{ github.ref }}"

Given explicit permissions are set
When grep checks the file
Then it contains "permissions: { contents: read }" (or `permissions:\n  contents: read`)

Given trivy fails on HIGH+ severity
When grep checks the trivy step
Then it contains "severity: 'CRITICAL,HIGH'" AND "exit-code: '1'"

Given gitleaks runs on full history
When grep checks the checkout step
Then it contains "fetch-depth: 0"

Given the workflow runs on a clean tree
When the workflow is dispatched manually with `gh workflow run security.yml`
Then all jobs exit 0 (no current vulnerabilities)
```

---

## Shell verification

```bash
test -f .github/workflows/security.yml
test -f .trivyignore

# Three required jobs
grep -qE "^\s*gitleaks:" .github/workflows/security.yml
grep -qE "^\s*trivy:" .github/workflows/security.yml
grep -qE "^\s*osv-scanner:" .github/workflows/security.yml

# Triggers
grep -qE "^\s*push:" .github/workflows/security.yml
grep -qE "^\s*pull_request:" .github/workflows/security.yml
grep -qE "^\s*schedule:" .github/workflows/security.yml
grep -qE "^\s*workflow_dispatch:" .github/workflows/security.yml

# Nightly cron
grep -q "cron: '0 3 \* \* \*'" .github/workflows/security.yml

# Concurrency
grep -q "concurrency:" .github/workflows/security.yml
grep -q "cancel-in-progress: true" .github/workflows/security.yml

# Permissions
grep -q "contents: read" .github/workflows/security.yml

# Trivy severity gate
grep -q "severity: 'CRITICAL,HIGH'" .github/workflows/security.yml
grep -q "exit-code: '1'" .github/workflows/security.yml

# Gitleaks full history
grep -q "fetch-depth: 0" .github/workflows/security.yml

# All three actions pinned (no @master, no @main, no @v0)
! grep -qE "@(master|main|v0)$" .github/workflows/security.yml
```

---

## Notes for coding agent

- Reference: `aegis/.github/workflows/security.yml` — 4 jobs (pip-audit + gitleaks + trivy + bandit) with `cron: '0 3 * * *'` schedule + `concurrency` group. We swap `pip-audit` + `bandit` for `osv-scanner` (TS-native equivalent that handles npm + lockfiles directly).
- **gitleaks binary (NOT gitleaks-action).** Spec originally referenced `gitleaks/gitleaks-action@v2`, but that action is *commercial* — Gitleaks LLC requires a paid per-organization license for org-owned repos (free only for personal user accounts). Concierge uses the gitleaks MIT-licensed CLI binary directly (same path as story-06's pre-commit hook). Version pinned at `8.30.1` in the workflow env block; bump via the CONTRIBUTING.md quarterly checklist.
- **`trivy-action@v0.36.0`** — pinned tag (NOT `@master`). The aegis reference uses `@master` which floats; find-evil's `ci.yml:326` pins to `@v0.36.0` with detailed rationale (CVE allowlist hardening). Concierge starts with `exit-code: '1'` (block on HIGH+); if base-image CVEs are unfixable, document each in `.trivyignore` with rationale (NOT silently downgrade exit-code to 0).
- **`osv-scanner-action@v2.3.8`** — Google-maintained OSV vulnerability scanner. Reads `pnpm-lock.yaml` + `package.json` + Foundry `contracts/lib/*` manifests → queries the OSV database. TS-native equivalent of Python's `pip-audit`. Spec patched 2026-06-09: `@v1` → `@v2.3.8` (v2 is current major); `bun.lockb` → `pnpm-lock.yaml` (pre-Bun→pnpm spec correction).
- **Schedule fires at 03:00 UTC nightly** — picks up zero-day CVEs published after the last PR landed. If a nightly run fails, the workflow opens a GitHub issue (separate follow-up: action `JasonEtco/create-an-issue@v2` on failure).
- **Concurrency group is `security-${{ github.ref }}`** (not `ci-`) so security runs in parallel with story-04's `ci.yml` — they aren't mutually exclusive.
- **Permissions are `contents: read` only** — no `security-events: write` needed unless we want SARIF uploads to GitHub Security tab. If we add SARIF later, extend permissions per-job.
- **`workflow_dispatch:`** lets Abu trigger a fresh security scan without a commit (useful before any Mainnet deploy).
- This workflow is a required-status-check on branch protection alongside CI jobs from story-04. Document in `.github/workflows/security.yml` top-comment.
