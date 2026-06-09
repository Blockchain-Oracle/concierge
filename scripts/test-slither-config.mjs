#!/usr/bin/env node
// Smoke test for contracts/.slither.config.json. Skips if slither isn't
// on PATH (CI installs it explicitly; local dev: `pip install
// slither-analyzer`). Run via `pnpm run slither:test`.
//
// Two fixtures — first proves `fail-on: high` bites, second proves
// `solc_remaps` resolves @openzeppelin imports against contracts/lib/.

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
  console.log('slither not on PATH — skipping. CI installs slither-analyzer explicitly.');
  console.log('Local dev: `pip install slither-analyzer==0.11.5`.');
  process.exit(0);
}

const sandbox = resolve(tmpdir(), `concierge-slither-fixture-${process.pid}`);

const SUICIDAL_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract Suicidal {
    function kill() public { selfdestruct(payable(msg.sender)); }
}
`;

// Imports @openzeppelin/contracts/utils/Strings.sol — exercises the
// solc_remaps array in .slither.config.json. If a remap drifts, slither
// emits "Source ... not found" and the test fails loudly.
const REMAP_SOL = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
contract RemapCheck {
    function asString(uint256 x) external pure returns (string memory) {
        return Strings.toString(x);
    }
}
`;

function report(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

function runSlither(file) {
  return spawnSync('slither', [file, '--config-file', SLITHER_CONFIG, '--solc-disable-warnings'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

try {
  mkdirSync(sandbox, { recursive: true });

  // ── Fixture 1: HIGH-severity (suicidal) — assert fail-on bites ──────
  const suicidal = resolve(sandbox, 'Suicidal.sol');
  writeFileSync(suicidal, SUICIDAL_SOL, 'utf8');
  const r1 = runSlither(suicidal);
  const out1 = `${r1.stdout}\n${r1.stderr}`;
  report('suicidal: slither exits non-zero', r1.status !== 0, `exit ${r1.status}`);
  report('suicidal: output mentions detector', /suicidal/i.test(out1));
  report('suicidal: NOT vacuous (analyzed > 0)', !/0\s+contracts?\s+analyzed/i.test(out1));

  // ── Fixture 2: @openzeppelin import — assert solc_remaps resolves ──
  const remap = resolve(sandbox, 'RemapCheck.sol');
  writeFileSync(remap, REMAP_SOL, 'utf8');
  const r2 = runSlither(remap);
  const out2 = `${r2.stdout}\n${r2.stderr}`;
  report('remap: NO "Source not found"', !/Source.*not found/i.test(out2));
  report('remap: NO "missing import"', !/missing import/i.test(out2));
  report('remap: NOT vacuous (analyzed > 0)', !/0\s+contracts?\s+analyzed/i.test(out2));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (process.exitCode && process.exitCode !== 0) {
  console.error('slither config smoke test FAILED');
  process.exit(process.exitCode);
}
console.log('slither config smoke test PASSED');
