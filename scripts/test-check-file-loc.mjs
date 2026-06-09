#!/usr/bin/env node
// Smoke test for scripts/check-file-loc.mjs.
// Creates three probes, asserts the script's exit code on each, cleans up via try/finally.
// Mirrors rapid-agents/scripts/test_check_max_lines.sh — every enforcement script gets a test.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/check-file-loc.mjs');

const PROBE_FAIL = resolve(REPO_ROOT, 'apps/_loc_probe_/probe.ts');
const PROBE_FAIL_DIR = dirname(PROBE_FAIL);
const PROBE_EXCLUDED = resolve(REPO_ROOT, 'packages/_loc_probe_/dist/big.ts');
const PROBE_EXCLUDED_DIR_TOP = resolve(REPO_ROOT, 'packages/_loc_probe_');

function content(lines) {
  const body = Array.from({ length: lines }, (_, i) => `export const x${i} = ${i};`).join('\n');
  return `${body}\n`;
}

function runScript() {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function assertExit(label, expected, actual, extra = '') {
  const ok = actual === expected;
  const tag = ok
    ? `${label}: ${expected === 1 ? 'FAIL' : 'PASS'} (expected)`
    : `${label}: WRONG (got ${actual}, expected ${expected})`;
  console.log(tag, extra);
  if (!ok) process.exitCode = 1;
}

let allOk = true;

try {
  // ── Probe 1: 401-line file under apps/ → script must exit 1 ─────────────
  mkdirSync(PROBE_FAIL_DIR, { recursive: true });
  writeFileSync(PROBE_FAIL, content(401), 'utf8');
  const r1 = runScript();
  assertExit('401-line', 1, r1.code);
  if (r1.code !== 1) {
    allOk = false;
    console.error('  stderr:', r1.stderr.slice(0, 500));
  }

  // ── Probe 2: 400-line file under apps/ → script must exit 0 ─────────────
  writeFileSync(PROBE_FAIL, content(400), 'utf8');
  const r2 = runScript();
  assertExit('400-line', 0, r2.code);
  if (r2.code !== 0) {
    allOk = false;
    console.error('  stderr:', r2.stderr.slice(0, 500));
  }

  // ── Probe 3: 401-line file under excluded dist/ → script must exit 0 ───
  // First remove probe 1/2 so the 401-line apps/ probe doesn't dirty probe 3.
  rmSync(PROBE_FAIL, { force: true });
  rmSync(PROBE_FAIL_DIR, { recursive: true, force: true });
  mkdirSync(dirname(PROBE_EXCLUDED), { recursive: true });
  writeFileSync(PROBE_EXCLUDED, content(401), 'utf8');
  const r3 = runScript();
  assertExit('excluded-path', 0, r3.code);
  if (r3.code !== 0) {
    allOk = false;
    console.error('  stderr:', r3.stderr.slice(0, 500));
  }
} finally {
  // Best-effort cleanup. Both probe dirs may or may not exist depending on which step we reached.
  rmSync(PROBE_FAIL, { force: true });
  rmSync(PROBE_FAIL_DIR, { recursive: true, force: true });
  rmSync(PROBE_EXCLUDED, { force: true });
  rmSync(PROBE_EXCLUDED_DIR_TOP, { recursive: true, force: true });
}

if (!allOk) {
  console.error('smoke test FAILED');
  process.exit(1);
}
console.log('smoke test PASSED');
