#!/usr/bin/env node
// Smoke test for .husky/* hook integrity. Catches the corruption
// failure mode CI cannot see: someone runs `chmod -x .husky/pre-commit`
// or accidentally clobbers a hook body, and the next contributor's
// `git commit` silently bypasses the entire chain (since git skips
// non-executable hooks without warning).
//
// Pattern: test-check-file-loc.mjs / test-tsconfig-strict.mjs /
// test-slither-config.mjs / test-commitlint-config.mjs / test-gitleaks-
// config.mjs — every enforcement contract gets a behavioral test.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

const HOOKS = [
  {
    name: 'pre-commit',
    path: resolve(REPO_ROOT, '.husky/pre-commit'),
    mustContain: ['lint-staged', 'scripts/check-file-loc.mjs', 'pnpm run typecheck', 'gitleaks'],
  },
  {
    name: 'commit-msg',
    path: resolve(REPO_ROOT, '.husky/commit-msg'),
    mustContain: ['commitlint', '--edit'],
  },
  {
    name: 'pre-push',
    path: resolve(REPO_ROOT, '.husky/pre-push'),
    mustContain: ['scripts/test-check-file-loc.mjs'],
  },
];

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

for (const hook of HOOKS) {
  let st;
  try {
    st = statSync(hook.path);
  } catch {
    report(`${hook.name}: file exists`, false, hook.path);
    continue;
  }
  report(`${hook.name}: file exists`, true);
  // mode & 0o111 — any execute bit (owner / group / other) is sufficient
  // for `git` to invoke the hook.
  report(
    `${hook.name}: executable bit set`,
    (st.mode & 0o111) !== 0,
    `mode ${(st.mode & 0o777).toString(8)}`,
  );
  const body = readFileSync(hook.path, 'utf8');
  for (const needle of hook.mustContain) {
    report(`${hook.name}: contains "${needle}"`, body.includes(needle));
  }
}

if (process.exitCode && process.exitCode !== 0) {
  console.error('husky hooks integrity test FAILED');
  process.exit(process.exitCode);
}
console.log('husky hooks integrity test PASSED');
