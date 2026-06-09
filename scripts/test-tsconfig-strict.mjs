#!/usr/bin/env node
// Smoke test for tsconfig.base.json strict-mode contract.
// Two-pronged: (1) STATIC — assert every load-bearing strict flag is true in
// the base config JSON (defends against future story X flipping a flag in a
// PR that survives review); (2) BEHAVIORAL — write a fixture with implicit
// `any`, run `tsc --noEmit` against it through the base config, assert
// non-zero exit AND stderr contains TS7006 (matches story-02 BDD step 5).
//
// Pattern from feedback_cicd_pattern.md: every enforcement contract gets a
// test. The 400-LOC budget has check-file-loc + its smoke test; the strict-
// mode budget gets this.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const BASE = resolve(REPO_ROOT, 'tsconfig.base.json');
const TSC = resolve(REPO_ROOT, 'node_modules/.bin/tsc');

const REQUIRED_TRUE = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noPropertyAccessFromIndexSignature',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'noImplicitReturns',
  'useUnknownInCatchVariables',
  'verbatimModuleSyntax',
];

const REQUIRED_FALSE = ['allowUnreachableCode', 'allowUnusedLabels'];

let allOk = true;

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) allOk = false;
}

// ── Static: parse base config + assert required flags ──────────────────
const cfg = JSON.parse(readFileSync(BASE, 'utf8'));
const opts = cfg.compilerOptions ?? {};

for (const flag of REQUIRED_TRUE) {
  report(
    `base.${flag}=true`,
    opts[flag] === true,
    opts[flag] === undefined ? 'missing' : `got ${opts[flag]}`,
  );
}
for (const flag of REQUIRED_FALSE) {
  report(
    `base.${flag}=false`,
    opts[flag] === false,
    opts[flag] === undefined ? 'missing' : `got ${opts[flag]}`,
  );
}

// ── Behavioral: implicit-any probe must fail with TS7006 ───────────────
const sandbox = resolve(tmpdir(), `concierge-tsconfig-strict-${process.pid}`);
try {
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(
    resolve(sandbox, 'tsconfig.json'),
    JSON.stringify({ extends: BASE, include: ['src/**/*'] }),
    'utf8',
  );
  mkdirSync(resolve(sandbox, 'src'), { recursive: true });
  writeFileSync(
    resolve(sandbox, 'src/bad.ts'),
    'export function leak(x) { return x + 1; }\n',
    'utf8',
  );

  const r = spawnSync(TSC, ['--noEmit', '--project', sandbox], { encoding: 'utf8' });
  const combined = `${r.stdout}\n${r.stderr}`;
  report('implicit-any rejected', r.status !== 0, `exit ${r.status}`);
  report(
    'TS7006 in output',
    combined.includes('TS7006'),
    combined.split('\n')[0]?.slice(0, 80) ?? '',
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (!allOk) {
  console.error('tsconfig-strict test FAILED');
  process.exit(1);
}
console.log('tsconfig-strict test PASSED');
