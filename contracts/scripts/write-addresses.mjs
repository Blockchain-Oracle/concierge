#!/usr/bin/env node
import { execSync } from 'node:child_process';
/**
 * Reads the Foundry broadcast artifact for DeployAll.s.sol and updates
 * packages/shared/src/addresses.ts with the deployed addresses.
 *
 * Usage:
 *   node contracts/scripts/write-addresses.mjs [--network sepolia|mainnet]
 *
 * Sepolia (default):
 *   Reads: contracts/broadcast/DeployAll.s.sol/5003/run-latest.json
 *   Writes: mantleSepolia block + removes from SEPOLIA_PENDING_ADDRESS_SLOTS
 *
 * Mainnet:
 *   Reads: contracts/broadcast/DeployAll.s.sol/5000/run-latest.json
 *   Writes: mantleMainnet block + removes from MAINNET_PENDING_ADDRESS_SLOTS
 *
 * Replacements are scoped to the target chain block only — both mantleMainnet
 * and mantleSepolia share field names (pool, oracle, USDC, …) and a global
 * regex would silently clobber audited addresses on the other chain.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// --- Network selection ---

const networkIdx = process.argv.indexOf('--network');
const networkArg = networkIdx !== -1 ? process.argv[networkIdx + 1] : undefined;

if (networkIdx !== -1 && (networkArg === undefined || networkArg.startsWith('--'))) {
  console.error('ERROR: --network requires a value: "sepolia" or "mainnet"');
  process.exit(1);
}

const network = networkArg ?? 'sepolia';

if (network !== 'sepolia' && network !== 'mainnet') {
  console.error(`Unknown --network "${network}" — expected "sepolia" or "mainnet"`);
  process.exit(1);
}

const CHAIN_ID = network === 'mainnet' ? '5000' : '5003';

const artifactPath = resolve(
  __dirname,
  '..',
  'broadcast',
  'DeployAll.s.sol',
  CHAIN_ID,
  'run-latest.json',
);
const addressesPath = resolve(REPO_ROOT, 'packages', 'shared', 'src', 'addresses.ts');

// --- Contract field maps (Solidity name → leaf field name → pending-slot dot-path) ---

// Sepolia deploys ALL mock contracts (mocks replace real protocols absent on Sepolia).
const SEPOLIA_CONTRACT_FIELD_MAP = [
  ['MockAavePool', 'pool', 'aave.pool'],
  ['MockAaveOracle', 'oracle', 'aave.oracle'],
  ['MockSUSDe', 'sUSDe', 'tokens.sUSDe'],
  ['MockUSDC', 'USDC', 'tokens.USDC'],
  ['MockUSDe', 'USDe', 'tokens.USDe'],
  ['MockUSDY', 'USDY', 'tokens.USDY'],
  ['MockMETH', 'mETH', 'tokens.mETH'],
  ['MockWMNT', 'WMNT', 'tokens.WMNT'],
  ['ConciergeRegistryProxy', 'conciergeRegistry', 'conciergeRegistry'],
];

// Mainnet only deploys ConciergeRegistry — all other protocols are already live.
const MAINNET_CONTRACT_FIELD_MAP = [
  ['ConciergeRegistryProxy', 'conciergeRegistry', 'conciergeRegistry'],
];

const CONTRACT_FIELD_MAP =
  network === 'mainnet' ? MAINNET_CONTRACT_FIELD_MAP : SEPOLIA_CONTRACT_FIELD_MAP;

const PENDING_SLOTS_CONST =
  network === 'mainnet' ? 'MAINNET_PENDING_ADDRESS_SLOTS' : 'SEPOLIA_PENDING_ADDRESS_SLOTS';

// --- Read broadcast artifact ---

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read broadcast artifact at ${artifactPath}: ${err.message}`);
  console.error(
    `Run: forge script script/DeployAll.s.sol --rpc-url $${network === 'mainnet' ? 'MANTLE_RPC_URL' : 'MANTLE_SEPOLIA_RPC_URL'} --broadcast`,
  );
  process.exit(1);
}

// Build contractName → contractAddress from CREATE transactions (first occurrence wins).
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

// --- Resolve updates from broadcast ---

const ADDRESS_FORMAT_RE = /^0x[a-fA-F0-9]{40}$/;

const updates = [];
const missing = [];
for (const [contractName, fieldName, pendingPath] of CONTRACT_FIELD_MAP) {
  const addr = deployed[contractName];
  if (!addr) {
    console.error(`  ✗ ${contractName} not found in broadcast artifact`);
    missing.push(contractName);
  } else if (!ADDRESS_FORMAT_RE.test(addr)) {
    console.error(`  ✗ ${contractName}: address "${addr}" is not a valid 40-hex EVM address`);
    missing.push(contractName);
  } else {
    updates.push({ contractName, fieldName, pendingPath, addr });
  }
}
if (missing.length > 0) {
  console.error('One or more required contracts missing from broadcast artifact. Aborting.');
  process.exit(1);
}

// --- Locate block boundaries in addresses.ts ---

const fullContent = readFileSync(addressesPath, 'utf8');
const MAINNET_MARKER = 'mantleMainnet: {';
const SEPOLIA_MARKER = 'mantleSepolia: {';

const mainnetStart = fullContent.indexOf(MAINNET_MARKER);
const sepoliaStart = fullContent.indexOf(SEPOLIA_MARKER);

if (mainnetStart === -1) {
  console.error(`Cannot locate '${MAINNET_MARKER}' in ${addressesPath}. Aborting.`);
  process.exit(1);
}
if (sepoliaStart === -1) {
  console.error(`Cannot locate '${SEPOLIA_MARKER}' in ${addressesPath}. Aborting.`);
  process.exit(1);
}
if (mainnetStart >= sepoliaStart) {
  console.error(
    `FATAL: '${SEPOLIA_MARKER}' appears before '${MAINNET_MARKER}' in addresses.ts.\n` +
      'Cannot safely scope replacements. Ensure mantleMainnet precedes mantleSepolia.',
  );
  process.exit(1);
}

// Split into three regions to scope replacements precisely.
// For mainnet: block = mantleMainnet block, suffix = mantleSepolia block + constants.
// For sepolia: block = mantleSepolia block + constants, suffix = '' (block runs to EOF).
let prefix, block, suffix;

if (network === 'mainnet') {
  prefix = fullContent.slice(0, mainnetStart);
  block = fullContent.slice(mainnetStart, sepoliaStart);
  suffix = fullContent.slice(sepoliaStart);
} else {
  prefix = fullContent.slice(0, sepoliaStart);
  block = fullContent.slice(sepoliaStart); // extends to EOF, includes SEPOLIA_PENDING_ADDRESS_SLOTS
  suffix = '';
  // Safety: sepoliaBlock must not contain mantleMainnet (file ordering assumption).
  if (block.includes('mantleMainnet')) {
    console.error(
      `FATAL: mantleMainnet block detected after mantleSepolia in addresses.ts.\n` +
        'Cannot safely scope replacements. Ensure mantleSepolia is the last chain block.',
    );
    process.exit(1);
  }
}

// ADDRESS_RE matches: `ZERO_ADDRESS` or `'0xABCD…1234' as Address`
const ADDRESS_RE = `(ZERO_ADDRESS|'0x[a-fA-F0-9]{40}'(?:\\s+as\\s+Address)?)`;

let updatedBlock = block;
let updatedSuffix = suffix;
let fieldMissing = false;

for (const { contractName, fieldName, pendingPath, addr } of updates) {
  // Escape fieldName for use in RegExp (defense against special-char field names).
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\b${escapedField}:\\s*)${ADDRESS_RE}`, 'g');
  const next = updatedBlock.replace(re, `$1'${addr}' as Address`);
  if (next === updatedBlock) {
    console.error(
      `  ✗ Field '${fieldName}' not found in ${network === 'mainnet' ? 'mantleMainnet' : 'mantleSepolia'} block (contract: ${contractName})`,
    );
    fieldMissing = true;
  } else {
    console.log(`  ✓ ${contractName} → ${fieldName}: ${addr}`);
    updatedBlock = next;

    // Remove this path from the pending-slots lockbox so the lockbox test keeps passing.
    // Escape the path for use in RegExp (only dots are special, but escape fully for safety).
    const escapedPath = pendingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const slotRe = new RegExp(`\\n\\s*'${escapedPath}',`);

    if (network === 'mainnet') {
      // MAINNET_PENDING_ADDRESS_SLOTS lives in the suffix (after the mantleSepolia block).
      const before = updatedSuffix;
      updatedSuffix = updatedSuffix.replace(slotRe, '');
      if (updatedSuffix === before) {
        console.warn(
          `  ⚠  Lockbox slot '${pendingPath}' not found in ${PENDING_SLOTS_CONST} — already removed or path changed?`,
        );
      }
    } else {
      // SEPOLIA_PENDING_ADDRESS_SLOTS is within the sepoliaBlock (runs to EOF).
      const before = updatedBlock;
      updatedBlock = updatedBlock.replace(slotRe, '');
      if (updatedBlock === before) {
        console.warn(
          `  ⚠  Lockbox slot '${pendingPath}' not found in ${PENDING_SLOTS_CONST} — already removed or path changed?`,
        );
      }
    }
  }
}

if (fieldMissing) {
  console.error(
    `One or more fields missing from ${network === 'mainnet' ? 'mantleMainnet' : 'mantleSepolia'} block. Aborting without write.`,
  );
  process.exit(1);
}

const content = prefix + updatedBlock + updatedSuffix;

if (content === fullContent) {
  console.log('addresses.ts already up to date — no changes written.');
} else {
  // Atomic write: write to .tmp then rename so a process kill mid-write cannot corrupt the file.
  const tmpPath = `${addressesPath}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, addressesPath);
  console.log(`\nWrote: ${addressesPath}`);

  // Verify the updated file passes typecheck AND the addresses lockbox test.
  console.log(`Running pnpm typecheck + shared test (${PENDING_SLOTS_CONST} lockbox)…`);
  try {
    execSync('pnpm run typecheck', { cwd: REPO_ROOT, stdio: 'inherit' });
    execSync('pnpm --filter @concierge/shared run test', { cwd: REPO_ROOT, stdio: 'inherit' });
    console.log('typecheck + test passed ✓');
  } catch (err) {
    console.error(`typecheck/test FAILED — reverting addresses.ts: ${err.message}`);
    try {
      const revertTmp = `${addressesPath}.tmp`;
      writeFileSync(revertTmp, fullContent, 'utf8');
      renameSync(revertTmp, addressesPath);
    } catch (revertErr) {
      console.error('FATAL: revert also failed. Restore addresses.ts from git manually.');
      console.error(revertErr);
    }
    process.exit(1);
  }
}
