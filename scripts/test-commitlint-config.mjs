#!/usr/bin/env node
// Smoke test for commitlint.config.mjs. Catches a silent regression where
// type-enum / subject-case stops firing and bad commit messages start
// passing through pre-commit unchallenged.
//
// Pattern: test-check-file-loc.mjs / test-tsconfig-strict.mjs /
// test-slither-config.mjs — every enforcement config gets a behavioral test.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

function runCommitlint(msg) {
  return spawnSync('pnpm', ['exec', 'commitlint'], {
    encoding: 'utf8',
    input: msg,
    cwd: REPO_ROOT,
  });
}

// ── Bad: no type, no colon. Expect non-zero exit. ─────────────────────
const r1 = runCommitlint('WIP fix stuff');
report('no-type rejected: exits non-zero', r1.status !== 0, `exit ${r1.status}`);
report(
  'no-type rejected: output mentions type-empty',
  /type-empty/i.test(`${r1.stdout}\n${r1.stderr}`),
);

// ── Bad: unknown type. ────────────────────────────────────────────────
const r2 = runCommitlint('xyzzy(sdk): something');
report('unknown-type rejected: exits non-zero', r2.status !== 0, `exit ${r2.status}`);
report(
  'unknown-type rejected: output mentions type-enum',
  /type-enum/i.test(`${r2.stdout}\n${r2.stderr}`),
);

// ── Bad: Title-Cased subject. ─────────────────────────────────────────
const r3 = runCommitlint('feat(sdk): Add Concierge Class');
report('title-case rejected: exits non-zero', r3.status !== 0, `exit ${r3.status}`);
report(
  'title-case rejected: output mentions subject-case',
  /subject-case/i.test(`${r3.stdout}\n${r3.stderr}`),
);

// ── Good: canonical conventional commit. Expect exit 0. ───────────────
const r4 = runCommitlint('feat(sdk): add Concierge class skeleton');
report('good message accepted: exit 0', r4.status === 0, `exit ${r4.status}`);

// ── Good: scope NOT in scope-enum (e.g. "xyzzy"). scope-enum at WARN
//   level should NOT block — exit 0, warning in output. ────────────────
const r5 = runCommitlint('feat(xyzzy): some change');
report('unknown-scope accepted (WARN-only): exit 0', r5.status === 0, `exit ${r5.status}`);
report(
  'unknown-scope accepted: output mentions scope-enum warning',
  /scope-enum/i.test(`${r5.stdout}\n${r5.stderr}`),
);

if (process.exitCode && process.exitCode !== 0) {
  console.error('commitlint config smoke test FAILED');
  process.exit(process.exitCode);
}
console.log('commitlint config smoke test PASSED');
