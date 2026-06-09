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
6. **Conventional commit** — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scopes: `sdk`, `shared`, `ui`, `skill`, `providers`, `web`, `mcp`, `worker`, `contracts`, `docs`, `ci`, `deps`, `types`, `quality`, `scaffold`, `sprint`.
7. **Open PR:** `gh pr create --fill`. PR title should reference the story (`feat(scope): summary (story-XX)`).
8. **Run the review fleet:** `/pr-review-toolkit:review-pr` — runs the 4 canonical reviewers (code-reviewer + silent-failure-hunter + type-design-analyzer + pr-test-analyzer) plus situational extras (simplification, dependency-safety, etc.) in parallel. Address blockers; reconcile any reviewer contradictions before applying fixes.
9. **Merge when CI is green AND review is acceptable:** `gh pr merge --squash --delete-branch`.
10. **Flip `docs/sprint-status.yaml` on main:** story status → `COMPLETE`, set `merged_at` + `pr_url`. Push.

## Quality non-negotiables

- **No mocks in the hot path. No half-built features.** Quality over deadline.
- **≤400 LOC per file.** Biome `noExcessiveLinesPerFile` is the CI authority; `scripts/check-file-loc.mjs` is the fast pre-commit guard. Split before 350.
- **No silent failures.** Config/lifecycle errors raise loud exit codes; never default to "exit 0 to keep CI green."
- **Pin exact versions** for tooling (`@biomejs/biome`, `husky`, `typescript`) — no `^` or `~`. Tooling drift is a real source of "works on my machine" PRs.

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
