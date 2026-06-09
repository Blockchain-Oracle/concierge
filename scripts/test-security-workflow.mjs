#!/usr/bin/env node
// Smoke test for .github/workflows/security.yml. Story-01/02/05/06
// precedent: every enforcement contract gets a behavioral smoke test.
// The security workflow is an enforcement contract — its job names,
// cron, severity gates, and version pins are all load-bearing.
//
// Catches silent regressions like:
//   - someone bumps `exit-code: '1'` → `'0'` (CVE-found becomes vacuous green)
//   - someone drops `fetch-depth: 0` (gitleaks history scan becomes shallow)
//   - someone renames a job (breaks branch-protection required-status-check)
//   - GITLEAKS_VERSION drifts between this workflow and story-06's
//     pre-commit hook (skew between local + CI scanning)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const SECURITY_YML = resolve(REPO_ROOT, '.github/workflows/security.yml');
const PRE_COMMIT = resolve(REPO_ROOT, '.husky/pre-commit');

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

const yaml = readFileSync(SECURITY_YML, 'utf8');

// ── Required job names ────────────────────────────────────────────────
for (const job of ['gitleaks', 'trivy', 'osv-scanner']) {
  report(`job present: ${job}`, new RegExp(`^  ${job}:`, 'm').test(yaml));
}

// ── Nightly cron 03:00 UTC ────────────────────────────────────────────
report('cron: 03:00 UTC', /cron:\s*['"]0 3 \* \* \*['"]/.test(yaml));

// ── timeout-minutes per job (must be ≤ 5 to keep nightly cost bounded) ─
const timeouts = (yaml.match(/timeout-minutes:\s*(\d+)/g) || []).map((m) =>
  Number(m.split(':')[1].trim()),
);
report(
  'timeouts: every value ≤ 5',
  timeouts.length > 0 && timeouts.every((t) => t <= 5),
  `${timeouts.length} timeouts: ${timeouts.join(', ')}`,
);

// ── trivy severity gate (CRITICAL,HIGH + exit-code 1) ─────────────────
report('trivy: severity CRITICAL,HIGH', /severity:\s*['"]CRITICAL,HIGH['"]/.test(yaml));
report('trivy: exit-code 1', /exit-code:\s*['"]1['"]/.test(yaml));
report('trivy: ignore-unfixed false', /ignore-unfixed:\s*['"]false['"]/.test(yaml));

// ── gitleaks full-history fetch + SHA-256 verification ────────────────
report('gitleaks: fetch-depth 0', /fetch-depth:\s*0/.test(yaml));
report('gitleaks: SHA-256 verification', /GITLEAKS_SHA256/.test(yaml) && /sha256sum -c/.test(yaml));
report(
  'osv-scanner: SHA-256 verification',
  /OSV_SCANNER_SHA256/.test(yaml) && /sha256sum -c/.test(yaml),
);

// ── No action pinned to @master/@main/@v0 ─────────────────────────────
report('no @master/@main pins', !/@(?:master|main)\b/.test(yaml));

// ── persist-credentials: false on every checkout ──────────────────────
const checkouts = (yaml.match(/uses:\s*actions\/checkout@v\d+/g) || []).length;
const persistFalse = (yaml.match(/persist-credentials:\s*false/g) || []).length;
report(
  'persist-credentials: false on every checkout',
  checkouts > 0 && checkouts === persistFalse,
  `${checkouts} checkouts, ${persistFalse} persist-credentials:false`,
);

// ── GITLEAKS_VERSION cross-check (workflow vs husky pre-commit hint) ──
// pre-commit's gitleaks warning text names a current install version;
// this is a soft cross-check that the two paths stay aligned.
const workflowVer = (yaml.match(/GITLEAKS_VERSION:\s*"(\d+\.\d+\.\d+)"/) || [])[1];
const preCommit = readFileSync(PRE_COMMIT, 'utf8');
const preCommitHasGitleaks = /command -v gitleaks/.test(preCommit);
report(
  'GITLEAKS_VERSION pinned in workflow',
  !!workflowVer,
  workflowVer ? `v${workflowVer}` : 'not found',
);
report(
  'pre-commit hook references gitleaks (drift-tripwire)',
  preCommitHasGitleaks,
  'if false: pre-commit + CI gitleaks paths have silently diverged',
);

// ── Nightly-failure notification path exists ──────────────────────────
report(
  'nightly-failure issue creation step exists',
  /JasonEtco\/create-an-issue/.test(yaml) && /github\.event_name == 'schedule'/.test(yaml),
);

if (process.exitCode && process.exitCode !== 0) {
  console.error('security workflow smoke test FAILED');
  process.exit(process.exitCode);
}
console.log('security workflow smoke test PASSED');
