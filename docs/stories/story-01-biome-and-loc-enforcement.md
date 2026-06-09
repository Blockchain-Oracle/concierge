# Story — Biome + 400-LOC enforcement

**ID:** story-01-biome-and-loc-enforcement
**Epic:** Epic E0 — Foundation
**Depends on:** story-00-monorepo-scaffold
**Estimate:** ~45min
**Status:** PENDING

---

## User story

**As a** Concierge maintainer
**I want to** lint + format with a single tool and have files >400 LOC fail CI
**So that** the codebase stays readable, modular, and consistent without manual policing

---

## File modification map

- `biome.json` — NEW — root config (`"$schema": "https://biomejs.dev/schemas/2.4.16/schema.json"`, `"root": true`) with `formatter`, `linter`, `assist`, `linter.rules.nursery.noExcessiveLinesPerFile { level: "error", options: { maxLines: 400, skipBlankLines: false } }` (verified against Biome 2.4.16 configuration schema — still in `nursery` in 2.x), `linter.rules.complexity.noExcessiveLinesPerFunction { level: "warn", options: { maxLines: 50 } }`, **`files.includes` with `!` negation** (Biome 2.x dropped `files.ignore` in favour of include-glob negation): `["**", "!**/abi/**", "!**/.next/**", "!**/dist/**", "!**/out/**", "!**/*.d.ts", "!**/coverage/**", "!**/.turbo/**", "!**/broadcast/**", "!**/.wrangler/**", "!**/node_modules/**", "!pnpm-lock.yaml"]`
- `package.json` — UPDATE — pin `@biomejs/biome` to a specific minor (per ADR-007: nursery rules can drift); add scripts `lint`, `format`, `check`, `loc:check`, `loc:test`
- `scripts/check-file-loc.mjs` — NEW — defense-in-depth Node walker. Walks `apps/`, `packages/`, `scripts/`, `contracts/src/`, `contracts/test/`, `contracts/script/`. Counts significant lines (skips blanks + line-comment prefixes `//`, `#`, `/*`, `*`, `<!--`). Three exit codes: `0` all-pass, `1` violations (printed to stderr with path + count + delta), `2` config error (missing root dir, non-UTF-8 file — raises explicitly, never silently skips). **Named exclude sets** (NOT substring match — substring match silently mis-excludes `apps/foo/rebuild/widget.ts` because it contains `build`):
  - `EXCLUDE_FILENAMES = new Set([])` (none for TS — Python's `__init__.py` doesn't apply)
  - `EXCLUDE_SUFFIXES = new Set(['.d.ts'])` (generated type defs)
  - `EXCLUDE_DIR_COMPONENTS = new Set(['_vendored', 'node_modules', '.next', 'dist', 'build', 'broadcast', '.wrangler', 'out', '.turbo', 'coverage', 'abi'])` (component match — `path.split('/').includes(c)`)
  - `EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.sol'])`
  - Accepts `--strict` flag (reserved for forward-compat; currently default behavior); argparse-style rejection of unknown flags
- `scripts/test-check-file-loc.mjs` — NEW — **self-contained smoke test for the LOC script.** Creates a 401-line probe under `apps/_loc_probe_/probe.ts`, asserts script exits with code `1`; replaces probe with 400-line content, asserts exit `0`; finally creates an excluded path (e.g. `packages/_loc_probe_/dist/big.ts` 401 lines) and asserts exit `0` (correctly excluded). Cleans up via `try/finally` (mirrors `rapid-agents/scripts/test_check_max_lines.sh` pattern). Run from repo root via `node scripts/test-check-file-loc.mjs`.
- `.husky/pre-commit` — NEW — runs `pnpm run check && node scripts/check-file-loc.mjs` (Biome + defense-in-depth LOC) on every commit. **NOT** `pnpm exec lint-staged` here — full-tree check; staged-only diff happens in `.lintstagedrc` (story-06).

---

## Acceptance criteria (BDD)

```
Given biome.json exists at repo root
When `pnpm exec biome check .` runs
Then exit code is 0 (no errors)

Given a test file is created with 401 lines of non-whitespace TS
When `pnpm exec biome check <file>` runs
Then it exits non-zero with the `noExcessiveLinesPerFile` rule firing

Given the biome nursery rule for max lines is enabled at error level
When `node --input-type=module -e "import fs from 'node:fs'; const c = JSON.parse(fs.readFileSync('./biome.json','utf8')); console.log(JSON.stringify(c.linter.rules.nursery))"` runs
Then output contains `"noExcessiveLinesPerFile"` and `"level":"error"` and `"maxLines":400`

Given the LOC defense-in-depth script exists
When `node scripts/check-file-loc.mjs` runs on the repo
Then exit code is 0 (no source file exceeds 400 LOC at this stage)

Given a 401-line non-comment file is created under `apps/`
When `node scripts/check-file-loc.mjs` runs
Then exit code is 1 and stderr contains the file path with line count and `over by 1`

Given a file >400 LOC exists under an excluded dir (e.g. `packages/foo/dist/big.ts`)
When `node scripts/check-file-loc.mjs` runs
Then exit code is 0 (correctly excluded)

Given a missing root dir is configured
When the script runs from a clean cwd without `apps/`
Then exit code is 2 (config error, NOT silent pass) and stderr names the missing root

Given the LOC script smoke test exists
When `node scripts/test-check-file-loc.mjs` runs
Then exit code is 0 and stdout includes `401-line: FAIL (expected)`, `400-line: PASS (expected)`, and `excluded-path: PASS (expected)`

Given a non-UTF-8 file is created under `apps/`
When the script encounters it
Then exit code is 2 with a UTF-8 decode error message (NEVER silently skip — config error not silent pass)

Given pre-commit hook is installed
When a file >400 LOC is staged and committed
Then the commit is BLOCKED by Biome AND `scripts/check-file-loc.mjs` (defense-in-depth)
```

---

## Shell verification

```bash
test -f biome.json
test -f scripts/check-file-loc.mjs
test -f .husky/pre-commit

# Biome config has the nursery rule at error level with maxLines 400
node --input-type=module -e "
  import fs from 'node:fs';
  const c = JSON.parse(fs.readFileSync('./biome.json', 'utf8'));
  if (c.linter?.rules?.nursery?.noExcessiveLinesPerFile?.level !== 'error') process.exit(1);
  if (c.linter?.rules?.nursery?.noExcessiveLinesPerFile?.options?.maxLines !== 400) process.exit(1);
"

# Biome installed at pinned version (no caret/tilde)
node -e "
  const pkg = require('./package.json');
  const v = pkg.devDependencies['@biomejs/biome'];
  if (!v || v.startsWith('^') || v.startsWith('~')) {
    console.error('Biome must be pinned (no ^ or ~)', v);
    process.exit(1);
  }
"

# Biome check passes on current repo
pnpm exec biome check .
test $? -eq 0

# LOC script enforces the limit
node scripts/check-file-loc.mjs
test $? -eq 0

# LOC script smoke test (creates probes, asserts script behavior, cleans up)
node scripts/test-check-file-loc.mjs
test $? -eq 0
```

---

## Notes for coding agent

- Per ADR-007: `noExcessiveLinesPerFile` is a Biome **nursery** rule in 2.4.16 (verified against `node_modules/@biomejs/biome/configuration_schema.json` 2026-06-09 — rule is in `linter.rules.nursery`, NOT in `style` despite some out-of-date docs pages claiming otherwise). Pin Biome to an EXACT version (e.g. `"2.4.16"`, not `^2.4` or `~2.4.16`) — nursery rules can move between minors (promotions, renamings, removals).
- Generated files (`**/abi/**`, `**/.next/**`, `**/dist/**`, etc.) MUST be excluded via `files.includes` negation (`!**/abi/**`) — **Biome 2.x dropped `files.ignore`** in favour of include-glob negation. Otherwise CI fails on auto-generated code.
- `scripts/check-file-loc.mjs` is defense-in-depth — runs as a fast pre-commit guard before Biome loads. Biome's rule is the CI authority.
- **Named exclude sets, NOT substring match.** Reference: `rapid-agents/scripts/check_max_lines.py:30-32`. Substring match silently mis-excludes paths like `apps/foo/rebuild/widget.ts` because they contain `build`. Use `Set` lookups + `path.split('/').includes(component)` for correctness.
- **No silent failures.** Missing root dir = exit `2`, NOT exit `0`. Non-UTF-8 file = exit `2`, NOT silent skip. Pre-commit + git ls-files only emit existing paths — anything else is an upstream bug that must surface.
- **Husky setup:** `pnpm exec husky init` then write the pre-commit hook content. Hook runs Biome + `scripts/check-file-loc.mjs` on every commit; staged-only filtering happens in `.lintstagedrc` (story-06).
- **The smoke test (`test-check-file-loc.mjs`) is mandatory** — Abu's cross-project pattern: every enforcement script gets a test. Reference: `rapid-agents/scripts/test_check_max_lines.sh`. Without it, the LOC script could regress silently and ship a 600-LOC file that Biome's nursery rule alone catches inconsistently.
- The 400-LOC budget is enforced per ADR-007 and architecture.md § Banned patterns.
