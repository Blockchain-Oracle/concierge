#!/usr/bin/env node
// Smoke test for .gitleaks.toml. Catches the highest-impact regression
// class: a secret-leak gate that silently STOPS firing.
//
// Fixture 1: Anthropic API key shape — proves `sk-ant-` rule fires HIGH.
// Fixture 2: Mantle private key shape in a .env file — proves the
//   path-scoped `mantle-private-key-in-env` rule fires only inside .env.
// Fixture 3: same shape OUTSIDE a .env file — proves the path scope
//   doesn't over-fire (it's a `0x...64-hex` shape that legitimately
//   appears in code comments, address constants, etc.).
//
// Skips gracefully if gitleaks not on PATH (CI's story-07 security
// workflow installs it; local: brew install gitleaks).
//
// Pattern: test-check-file-loc.mjs / test-tsconfig-strict.mjs /
// test-slither-config.mjs — every enforcement config gets a behavioral
// test (feedback_cicd_pattern.md).

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const GITLEAKS_CONFIG = resolve(REPO_ROOT, '.gitleaks.toml');

const which = spawnSync('which', ['gitleaks'], { encoding: 'utf8' });
if (which.status !== 0) {
  console.log('gitleaks not on PATH — skipping. CI runs gitleaks unconditionally.');
  console.log(
    'Local: brew install gitleaks / apt install gitleaks / go install github.com/gitleaks/gitleaks/v8@latest',
  );
  process.exit(0);
}

const sandbox = resolve(tmpdir(), `concierge-gitleaks-fixture-${process.pid}`);

const ANTHROPIC_FIXTURE = `// SPDX-License-Identifier: MIT
// Fixture: should be flagged by .gitleaks.toml's anthropic-api-key rule.
const KEY = "sk-ant-api03-${'a'.repeat(95)}";
`;

const ENV_PRIVATE_KEY = `MANTLE_PRIVATE_KEY=0x${'a'.repeat(64)}
`;

const CODE_LIKELY_FALSE_POSITIVE = `// 0x${'a'.repeat(64)} is a 64-hex address constant in a code comment.
// Should NOT be flagged because mantle-private-key-in-env is .env-path-scoped.
const ADDR = "0x${'a'.repeat(40)}"; // 40-hex address, not a key
`;

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

function runGitleaks(file) {
  // `-v` emits per-finding RuleID lines so the smoke test can assert
  // which rule fired (default mode only prints "leaks found: N" without
  // rule names; with --report-path, gitleaks exits 0 instead of 1 and
  // writes to a file). `-v` is the simplest shape that gives us both
  // exit-code semantics AND rule visibility in stdout.
  return spawnSync(
    'gitleaks',
    ['detect', '--no-banner', '--config', GITLEAKS_CONFIG, '--no-git', '-v', '--source', file],
    { encoding: 'utf8' },
  );
}

try {
  mkdirSync(sandbox, { recursive: true });

  // ── Fixture 1: Anthropic key — expect non-zero exit + rule name ──
  const f1 = resolve(sandbox, 'leak.ts');
  writeFileSync(f1, ANTHROPIC_FIXTURE, 'utf8');
  const r1 = runGitleaks(f1);
  const out1 = `${r1.stdout}\n${r1.stderr}`;
  report('anthropic: gitleaks exits non-zero', r1.status !== 0, `exit ${r1.status}`);
  report('anthropic: output mentions rule', /anthropic-api-key/i.test(out1));

  // ── Fixture 2: Mantle privkey in .env — expect non-zero exit ─────
  const envFile = resolve(sandbox, '.env');
  writeFileSync(envFile, ENV_PRIVATE_KEY, 'utf8');
  const r2 = runGitleaks(envFile);
  const out2 = `${r2.stdout}\n${r2.stderr}`;
  report('env-privkey: gitleaks exits non-zero', r2.status !== 0, `exit ${r2.status}`);
  report(
    'env-privkey: output mentions mantle-private-key-in-env',
    /mantle-private-key-in-env/i.test(out2),
  );

  // ── Fixture 3: same shape OUTSIDE .env — rule path-scope holds ────
  const codeFile = resolve(sandbox, 'addresses.ts');
  writeFileSync(codeFile, CODE_LIKELY_FALSE_POSITIVE, 'utf8');
  const r3 = runGitleaks(codeFile);
  // Note: upstream default rules might still flag the 64-hex as
  // high-entropy. We assert ONLY that mantle-private-key-in-env does
  // NOT fire (that's the path-scope contract).
  const out3 = `${r3.stdout}\n${r3.stderr}`;
  report(
    'addresses.ts: mantle-private-key-in-env path-scope holds (not fired)',
    !/mantle-private-key-in-env/i.test(out3),
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (process.exitCode && process.exitCode !== 0) {
  console.error('gitleaks config smoke test FAILED');
  process.exit(process.exitCode);
}
console.log('gitleaks config smoke test PASSED');
