#!/usr/bin/env node
import { execSync } from 'node:child_process';
/**
 * Reads the Foundry broadcast artifact for DeployAll.s.sol and updates
 * packages/shared/src/addresses.ts with the deployed Sepolia addresses.
 *
 * Usage:
 *   node contracts/scripts/write-addresses.mjs [--network sepolia]
 *
 * Reads: contracts/broadcast/DeployAll.s.sol/5003/run-latest.json
 * Writes: packages/shared/src/addresses.ts  (mantleSepolia block only)
 *
 * Each field is updated with a targeted replacement that matches the
 * field name + its current value (ZERO_ADDRESS or an existing 0x address),
 * so the script is idempotent and safe to re-run on updated deployments.
 *
 * The replacement is scoped to the mantleSepolia block only — both
 * mantleMainnet and mantleSepolia share field names (pool, oracle, USDC, …)
 * and a global regex would silently clobber 8 audited Mainnet addresses.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CHAIN_ID = '5003';

const artifactPath = resolve(
  __dirname,
  '..',
  'broadcast',
  'DeployAll.s.sol',
  CHAIN_ID,
  'run-latest.json',
);
const addressesPath = resolve(REPO_ROOT, 'packages', 'shared', 'src', 'addresses.ts');

// --- Read broadcast artifact ---

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read broadcast artifact at ${artifactPath}`);
  console.error(
    'Run: forge script script/DeployAll.s.sol --rpc-url $MANTLE_SEPOLIA_RPC_URL --broadcast',
  );
  process.exit(1);
}

// Build contractName → contractAddress from CREATE transactions (first occurrence wins)
/** @type {Record<string, string>} */
const deployed = {};
for (const tx of artifact.transactions ?? []) {
  if (
    tx.transactionType === 'CREATE' &&
    tx.contractName &&
    tx.contractAddress &&
    !deployed[tx.contractName]
  ) {
    deployed[tx.contractName] = tx.contractAddress;
  }
}

// --- Map Solidity contract names to addresses.ts field names ---

// Each entry: [Solidity contract name, leaf field name in addresses.ts mantleSepolia block]
const CONTRACT_FIELD_MAP = [
  ['MockAavePool', 'pool'],
  ['MockAaveOracle', 'oracle'],
  ['MockSUSDe', 'sUSDe'],
  ['MockUSDC', 'USDC'],
  ['MockUSDe', 'USDe'],
  ['MockUSDY', 'USDY'],
  ['MockMETH', 'mETH'],
  ['MockWMNT', 'WMNT'],
  ['ConciergeRegistryProxy', 'conciergeRegistry'],
];

const updates = [];
const missing = [];
for (const [contractName, fieldName] of CONTRACT_FIELD_MAP) {
  const addr = deployed[contractName];
  if (!addr) {
    console.error(`  ✗ ${contractName} not found in broadcast artifact`);
    missing.push(contractName);
  } else {
    updates.push({ contractName, fieldName, addr });
  }
}
if (missing.length > 0) {
  console.error('One or more required contracts missing from broadcast artifact. Aborting.');
  process.exit(1);
}

// --- Update addresses.ts — scoped to mantleSepolia block only ---

const fullContent = readFileSync(addressesPath, 'utf8');
const SEPOLIA_MARKER = 'mantleSepolia: {';
const sepoliaStart = fullContent.indexOf(SEPOLIA_MARKER);
if (sepoliaStart === -1) {
  console.error(`Cannot locate '${SEPOLIA_MARKER}' in ${addressesPath}. Aborting.`);
  process.exit(1);
}

const prefix = fullContent.slice(0, sepoliaStart);
let sepoliaBlock = fullContent.slice(sepoliaStart);

// Safety: if mantleMainnet appears after mantleSepolia: { in the file, the scoping is unsafe —
// replacing fields in sepoliaBlock would also hit Mainnet fields. Abort loudly instead.
if (sepoliaBlock.includes('mantleMainnet')) {
  console.error(
    'FATAL: mantleMainnet block detected after mantleSepolia in addresses.ts.\n' +
      'Cannot safely scope replacements. Ensure mantleSepolia is the last chain block.',
  );
  process.exit(1);
}

// ADDRESS_RE matches: `ZERO_ADDRESS` or `'0xABCD…1234' as Address`
const ADDRESS_RE = `(ZERO_ADDRESS|'0x[a-fA-F0-9]{40}'(?:\\s+as\\s+Address)?)`;

let fieldMissing = false;
for (const { contractName, fieldName, addr } of updates) {
  // Anchored pattern: match the field name followed by a colon, then the current address value.
  // Applied only to sepoliaBlock so mantleMainnet fields with the same name are never touched.
  const re = new RegExp(`(\\b${fieldName}:\\s*)${ADDRESS_RE}`, 'g');
  const next = sepoliaBlock.replace(re, `$1'${addr}' as Address`);
  if (next === sepoliaBlock) {
    console.error(
      `  ✗ Field '${fieldName}' not found in mantleSepolia block (contract: ${contractName})`,
    );
    fieldMissing = true;
  } else {
    console.log(`  ✓ ${contractName} → ${fieldName}: ${addr}`);
    sepoliaBlock = next;
  }
}

if (fieldMissing) {
  console.error('One or more fields missing from mantleSepolia block. Aborting without write.');
  process.exit(1);
}

const content = prefix + sepoliaBlock;

if (content === fullContent) {
  console.log('addresses.ts already up to date — no changes written.');
} else {
  writeFileSync(addressesPath, content, 'utf8');
  console.log(`\nWrote: ${addressesPath}`);

  // Verify the updated file passes both typecheck AND the addresses lockbox test.
  // typecheck alone is insufficient: the SEPOLIA_PENDING_ADDRESS_SLOTS lockbox test
  // asserts that the pending-slot list matches every zero-address Sepolia path — after
  // a successful deploy the populated slots must be removed from that list or the test fails.
  console.log('Running pnpm typecheck + test…');
  try {
    execSync('pnpm run typecheck', { cwd: REPO_ROOT, stdio: 'inherit' });
    execSync('pnpm --filter @concierge/shared run test', { cwd: REPO_ROOT, stdio: 'inherit' });
    console.log('typecheck + test passed ✓');
  } catch {
    console.error('typecheck/test FAILED — reverting addresses.ts');
    try {
      writeFileSync(addressesPath, fullContent, 'utf8');
    } catch (revertErr) {
      console.error('FATAL: revert also failed. Restore addresses.ts from git manually.');
      console.error(revertErr);
    }
    process.exit(1);
  }
}
