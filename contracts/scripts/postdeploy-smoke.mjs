#!/usr/bin/env node
/**
 * Post-deploy smoke check for Mantle Mainnet (chain 5000).
 *
 * Reads deployed addresses from packages/shared/src/addresses.ts and issues
 * read-only on-chain calls to verify the deploy is live and correctly wired.
 * Uses `cast call` (Foundry) so there are no npm dependencies.
 *
 * Usage (from repo root after deploy-mainnet.sh runs):
 *   node contracts/scripts/postdeploy-smoke.mjs
 *   MANTLE_RPC_URL=https://rpc.mantle.xyz node contracts/scripts/postdeploy-smoke.mjs
 *
 * Exit codes: 0 = all checks passed, 1 = at least one check failed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const RPC_URL = process.env.MANTLE_RPC_URL ?? 'https://rpc.mantle.xyz';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// --- Parse mainnet addresses from addresses.ts ---

const addressesPath = resolve(REPO_ROOT, 'packages', 'shared', 'src', 'addresses.ts');
let content;
try {
  content = readFileSync(addressesPath, 'utf8');
} catch (err) {
  console.error(`SMOKE FAIL: Cannot read addresses.ts at ${addressesPath}: ${err.message}`);
  process.exit(1);
}

const MAINNET_MARKER = 'mantleMainnet: {';
const SEPOLIA_MARKER = 'mantleSepolia: {';
const mainnetStart = content.indexOf(MAINNET_MARKER);
const sepoliaStart = content.indexOf(SEPOLIA_MARKER);

if (mainnetStart === -1 || sepoliaStart === -1) {
  console.error('SMOKE FAIL: Cannot locate block markers in addresses.ts');
  process.exit(1);
}

const mainnetBlock = content.slice(mainnetStart, sepoliaStart);

/** @returns {string|null} */
function extractField(fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = mainnetBlock.match(new RegExp(`\\b${escaped}:\\s*'(0x[a-fA-F0-9]{40})'`));
  return m ? m[1] : null;
}

const addrs = {
  conciergeRegistry: extractField('conciergeRegistry'),
  aavePool: extractField('pool'),
  aaveProvider: extractField('addressesProvider'),
  identityRegistry: extractField('identityRegistry'),
};

// Guard: abort early if conciergeRegistry was not yet populated (pre-deploy run)
if (!addrs.conciergeRegistry || addrs.conciergeRegistry === ZERO_ADDR) {
  console.error(
    'SMOKE FAIL: conciergeRegistry in addresses.ts is still zero-address — ' +
      'run `node contracts/scripts/write-addresses.mjs --network mainnet` first.',
  );
  process.exit(1);
}

// --- cast call wrapper ---
// spawnSync argv array prevents shell injection via a crafted RPC_URL or address value.

/** @param {string} addr @param {string} sig @param {string[]} args @returns {string|null} */
function castCall(addr, sig, args = []) {
  const result = spawnSync('cast', ['call', addr, sig, ...args, '--rpc-url', RPC_URL], {
    encoding: 'utf8',
  });
  if (result.error) {
    console.error(`  cast call error (${sig}): ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    console.error(`  cast call failed (${sig}): ${(result.stderr ?? '').trim()}`);
    return null;
  }
  return result.stdout.trim();
}

// --- Broadcast artifact: read deployer address ---
// Fail-hard: the DEFAULT_ADMIN_ROLE check is a security assertion, not optional.

const broadcastPath = resolve(
  __dirname,
  '..',
  'broadcast',
  'DeployAll.s.sol',
  '5000',
  'run-latest.json',
);
let deployer;
try {
  const artifact = JSON.parse(readFileSync(broadcastPath, 'utf8'));
  const firstCreate = (artifact.transactions ?? []).find((tx) => tx.transactionType === 'CREATE');
  if (!firstCreate?.from) {
    console.error(
      'SMOKE FAIL: No CREATE transaction found in broadcast artifact — cannot verify ADMIN_ROLE.\n' +
        `  Expected: ${broadcastPath}`,
    );
    process.exit(1);
  }
  deployer = firstCreate.from;
} catch (err) {
  console.error(
    `SMOKE FAIL: Cannot read broadcast artifact at ${broadcastPath}: ${err.message}\n` +
      '  Run deploy-mainnet.sh first, or check that the broadcast file was not deleted.',
  );
  process.exit(1);
}

// --- Assertions ---

let passed = 0;
let failed = 0;

function assert(label, result, expected) {
  if (result === null) {
    console.error(`  ✗ FAIL  ${label}: cast call returned null (cast not found or RPC error)`);
    failed++;
    return;
  }
  // cast call wraps (string) ABI return types in outer double-quotes; strip them before comparison.
  const normalised = result
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .toLowerCase();
  const ok =
    typeof expected === 'function'
      ? expected(normalised)
      : normalised === String(expected).toLowerCase();
  if (ok) {
    console.log(`  ✓ PASS  ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL  ${label}: got "${result}", expected "${expected}"`);
    failed++;
  }
}

console.log(`\nPostdeploy smoke — Mantle Mainnet (${RPC_URL})\n`);

// 1. ConciergeRegistry: nextAgentId() should be 1 on a fresh deploy (no agents registered yet)
assert(
  'ConciergeRegistry.nextAgentId() == 1',
  castCall(addrs.conciergeRegistry, 'nextAgentId()(uint256)'),
  '1',
);

// 2. ConciergeRegistry: deployer holds DEFAULT_ADMIN_ROLE (bytes32 zero = DEFAULT_ADMIN_ROLE)
const ADMIN_ROLE = '0x' + '0'.repeat(64);
assert(
  `ConciergeRegistry.hasRole(DEFAULT_ADMIN_ROLE, deployer=${deployer.slice(0, 10)}…)`,
  castCall(addrs.conciergeRegistry, 'hasRole(bytes32,address)(bool)', [ADMIN_ROLE, deployer]),
  'true',
);

// 3. Aave V3 Pool: ADDRESSES_PROVIDER() returns the known provider address
if (addrs.aavePool && addrs.aaveProvider) {
  assert(
    `Aave Pool.ADDRESSES_PROVIDER() == ${addrs.aaveProvider.slice(0, 10)}…`,
    castCall(addrs.aavePool, 'ADDRESSES_PROVIDER()(address)'),
    (result) => result === addrs.aaveProvider.toLowerCase(),
  );
} else {
  console.warn('  ⚠  SKIP  Aave Pool check — addresses not parsed');
}

// 4. ERC-8004 Identity Registry: name() == "AgentIdentity" (sanity-check external dep wiring)
// cast call normalises the (string) return with outer quotes stripped in `assert` above.
if (addrs.identityRegistry) {
  assert(
    'ERC-8004 IdentityRegistry.name() == "AgentIdentity"',
    castCall(addrs.identityRegistry, 'name()(string)'),
    'agentidentity',
  );
} else {
  console.warn('  ⚠  SKIP  ERC-8004 Identity check — address not parsed');
}

// --- Summary ---
console.log(`\n${passed + failed} check(s): ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
