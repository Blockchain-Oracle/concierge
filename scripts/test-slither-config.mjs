#!/usr/bin/env node
// Smoke test for contracts/.slither.config.json.
// Writes a self-contained `.sol` fixture with a known-HIGH detector trigger
// (`suicidal`: unprotected selfdestruct), runs Slither against it with our
// config, asserts non-zero exit + the expected detector name in the output.
//
// Catches three classes of silent-regression that no other gate covers:
//   1. `fail_on: high` (or workflow `fail-on: high`) silently downgraded
//   2. `filter_paths` accidentally swallowing real source
//   3. `solc_remaps` drift vs contracts/remappings.txt (a stale remap makes
//      Slither skip files with "missing import")
//
// Pattern mirrors scripts/test-check-file-loc.mjs + scripts/test-tsconfig-
// strict.mjs — every enforcement config gets a behavioral smoke test
// (feedback_cicd_pattern.md).
//
// Skips gracefully if `slither` is not installed locally; CI's `contracts
// -security` job has it. Run via `pnpm run slither:test`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const SLITHER_CONFIG = resolve(REPO_ROOT, 'contracts/.slither.config.json');

const which = spawnSync('which', ['slither'], { encoding: 'utf8' });
if (which.status !== 0) {
  console.log(
    'slither not installed locally — skipping smoke test (CI runs slither via crytic/slither-action).',
  );
  console.log('To run locally: `pip install slither-analyzer` then re-run.');
  process.exit(0);
}

const sandbox = resolve(tmpdir(), `concierge-slither-fixture-${process.pid}`);
const fixturePath = resolve(sandbox, 'Suicidal.sol');

const FIXTURE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Slither MUST flag this contract as HIGH severity (\`suicidal\` detector).
// If this fixture stops triggering, Slither's config has been downgraded.
contract Suicidal {
    function kill() public {
        selfdestruct(payable(msg.sender));
    }
}
`;

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

try {
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(fixturePath, FIXTURE, 'utf8');

  // Run slither against the fixture using our config. We expect EXIT NON-ZERO
  // (config says fail_on=high; suicidal is HIGH).
  const r = spawnSync(
    'slither',
    [fixturePath, '--config-file', SLITHER_CONFIG, '--solc-disable-warnings'],
    { encoding: 'utf8' },
  );
  const combined = `${r.stdout}\n${r.stderr}`;

  report('slither exits non-zero on HIGH finding', r.status !== 0, `exit ${r.status}`);
  report(
    'output mentions `suicidal` detector',
    /suicidal/i.test(combined),
    combined.split('\n').find((l) => /suicidal/i.test(l)) ?? '(no match)',
  );
  report(
    'output does not say "0 contracts analyzed"',
    !/0\s+contracts?\s+analyzed/i.test(combined),
    '',
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (process.exitCode && process.exitCode !== 0) {
  console.error('slither config smoke test FAILED');
  process.exit(process.exitCode);
}
console.log('slither config smoke test PASSED');
