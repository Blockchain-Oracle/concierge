# Contributing to Concierge

Short version: one story per branch, conventional commits, PR review fleet, then merge.

## Setup

```bash
git clone https://github.com/Blockchain-Oracle/concierge.git
cd concierge
pnpm install        # bootstraps husky pre-commit hook via the `prepare` script
```

Requirements: Node ≥ 22, pnpm ≥ 10 (the repo pins `packageManager: pnpm@10.33.0`; with Corepack enabled, `pnpm install` will provision the right version automatically).

## Local gates

Before opening a PR, run the same checks CI runs:

```bash
pnpm run check         # Biome lint + format + import sort
pnpm run typecheck     # tsc -b --noEmit across the project reference graph
pnpm run loc:check     # 400-LOC defense-in-depth walker
pnpm run test:config   # smoke tests for the LOC + tsconfig-strict enforcement contracts
pnpm run test          # workspace-wide tests (no-op until packages with tests exist)
```

`pre-commit` runs `check` + `loc:check` automatically. If a real emergency requires bypassing, `git commit --no-verify` works — but CI re-runs every gate, so it buys nothing once you push.

## Workflow

1. **Pick the next PENDING story** in `docs/sprint-status.yaml` whose `depends_on` are all `COMPLETE`. Story-00 is the execution root; story-300 is the architectural keystone.
2. **Read the full story spec** — including the BDD acceptance criteria, file modification map, and any referenced ADRs in `docs/architecture.md`. Patch the spec in the same coherent pass if you find drift.
3. **Branch:** `git checkout -b story/<slug>`
4. **Tests first** for behavioral work; spec-driven for config work.
5. **Implement** strictly within the story's file modification map. No half-built features; no hot-path mocks.
6. **Conventional commit** — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scopes (matches the scope-enum that story-06 will enforce via commitlint): `sdk`, `shared`, `ui`, `skill`, `providers`, `web`, `mcp`, `worker`, `contracts`, `docs`, `ci`, `deps`.
7. **Open PR:** `gh pr create --fill`. PR title should reference the story (`feat(scope): summary (story-XX)`).
8. **Run the review fleet:** `/pr-review-toolkit:review-pr` — runs the 4 canonical reviewers (code-reviewer + silent-failure-hunter + type-design-analyzer + pr-test-analyzer) plus situational extras (simplification, dependency-safety, etc.) in parallel. Address blockers; reconcile any reviewer contradictions before applying fixes.
9. **Merge when CI is green AND review is acceptable:** `gh pr merge --squash --delete-branch`.
10. **Flip `docs/sprint-status.yaml` on main:** story status → `COMPLETE`, set `merged_at` + `pr_url`. Push.

## Quality non-negotiables

- **No mocks in the hot path. No half-built features.** Quality over deadline.
- **≤400 LOC per file.** Biome `noExcessiveLinesPerFile` is the CI authority; `scripts/check-file-loc.mjs` is the fast pre-commit guard. Split before 350.
- **No silent failures.** Config/lifecycle errors raise loud exit codes; never default to "exit 0 to keep CI green."
- **Pin exact versions** for tooling (`@biomejs/biome`, `husky`, `typescript`) — no `^` or `~`. Tooling drift is a real source of "works on my machine" PRs.

## Dependabot PRs

Dependabot opens grouped PRs weekly for npm and github-actions ecosystems (`/.github/dependabot.yml`). **github-actions PRs require human review before merge — do not enable auto-merge for them.** A compromised action tag (the tj-actions class of attack) ships into the workflow on the same `@v<major>` reference; the human review is the defense.

npm-ecosystem PRs are lower-risk thanks to the lockfile + `pnpm.onlyBuiltDependencies: []` allowlist (blocks dep postinstall scripts), but still benefit from a quick eyeball pass.

**actionlint is Dependabot-tracked** via the `reviewdog/action-actionlint` wrapper — the github-actions ecosystem entry in `dependabot.yml` covers it automatically. No manual binary pinning required.

## Manual-bump checklist (quarterly, not Dependabot-tracked)

A few tooling versions live OUTSIDE the npm + github-actions ecosystems Dependabot watches. Bump them by hand every quarter (or when CI surfaces a regression):

- **Node** (`NODE_VERSION` env in `.github/workflows/ci.yml` + `.github/workflows/contracts.yml`, `engines.node` in `package.json`) — currently `22`.
- **pnpm** (`engines.pnpm` + `packageManager` in `package.json`) — currently `10.33.0`. (`pnpm/action-setup` reads `packageManager` directly; no separate workflow pin.)
- **Python** (`actions/setup-python with: python-version` in `.github/workflows/ci.yml`) — currently `3.11`. Affects Slither runtime in the `test-config` smoke.
- **Solidity compiler** (`solc` in `contracts/foundry.toml`) — currently `"0.8.26"`.
- **EVM hardfork** (`evm_version` in `contracts/foundry.toml`) — currently `"shanghai"` (verified against Mantle Mainnet via direct PUSH0 RPC test). Bumps to `cancun` only after `cast`-verifying the specific Cancun opcodes (MCOPY/TLOAD/TSTORE/BLOBHASH) on Mantle.
- **Foundry binary** (`with: version:` in `.github/workflows/contracts.yml`) — currently `v1.7.1`.
- **Slither** (`with: slither-version:` in `.github/workflows/contracts.yml` + `pip install slither-analyzer==X.Y.Z` in `.github/workflows/ci.yml`) — currently `0.11.5`. Bump both lines together to keep CI's `test-config` smoke and the actual `contracts-security` job on the same version.
- **OpenZeppelin Contracts / Aave V3 Origin / forge-std** (`forge install ... @vX.Y.Z` in `contracts/scripts/install-deps.sh`) — currently OZ `v5.6.1`, aave-v3-origin `v3.6.0`, forge-std `v1.16.1`.

Procedure: bump → run full CI locally (`pnpm run check && pnpm run typecheck && pnpm run test:config && cd contracts && forge fmt --check && forge test && forge coverage --report summary`) → if green, open a `chore(deps): bump <thing>` PR.

## Where things are

- `docs/` — PRD, architecture (19 ADRs), ux-spec, epics (16, 110 stories), sprint-status, all story files.
- `research/concierge/` — domain knowledge and audits. `CONTEXT.md` is the entry point.
- `archive/` — historical artefacts (predecessor wedge, pre-decision concept pool). Not auto-loaded.
- `apps/` — `web/` (Next.js), `mcp/` (Cloudflare Worker MCP transport), `worker/` (BullMQ tick worker).
- `packages/` — `sdk/`, `shared/`, `ui/`, `skill/`, plus `packages/providers/*` for the 7 protocol adapters.
- `contracts/` — Foundry (initialised in story-03).
- `scripts/` — enforcement scripts (LOC walker, tsconfig-strict probe) and their smoke tests.

## License

MIT. See `LICENSE`.
