// Anvil process management and mock contract deployment for integration tests.
// Each test file spawns its own Anvil instance for true isolation.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from '@concierge/shared';
import {
  type Abi,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  parseAbi,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_OUT = resolve(__dirname, '../../../../../contracts/out');
// Resolve via env override first, then fall back to PATH lookup so CI and
// other machines work without per-developer path configuration.
const ANVIL_BIN = process.env.ANVIL_BIN ?? 'anvil';

// Anvil deterministic accounts from mnemonic "test test ... junk" — 10_000 ETH each, all unlocked.
// These must be used as JSON-RPC accounts in tests; arbitrary private keys fail with "No Signer".
export const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

// Accounts #1-#9 from the Anvil mnemonic — safe to use as JSON-RPC accounts in tests.
export const ANVIL_ACCOUNTS = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // #1
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // #2
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // #3
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // #4
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', // #5
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9', // #6
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', // #7
  '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', // #8
  '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720', // #9
] as const satisfies Address[];

export interface AnvilInstance {
  readonly port: number;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly stop: () => Promise<void>;
}

function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => res((addr as { port: number }).port));
    });
    srv.on('error', rej);
  });
}

export async function startAnvil(): Promise<AnvilInstance> {
  const port = await getFreePort();

  return new Promise((resolve, reject) => {
    // No --block-time: Anvil defaults to instant mining (one block per tx).
    const proc = spawn(ANVIL_BIN, ['--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let stopping = false;
    const buf: string[] = [];

    // Cleared on success to prevent a timer fire against an already-resolved promise.
    const timer = setTimeout(() => {
      if (!started) {
        proc.kill('SIGTERM');
        reject(
          new Error(
            `Anvil startup timed out after 15s. ` +
              `Install Foundry (https://getfoundry.sh) or set ANVIL_BIN=/path/to/anvil.`,
          ),
        );
      }
    }, 15_000);

    const onData = (chunk: Buffer) => {
      buf.push(chunk.toString());
      const text = buf.join('');
      if (!started && text.includes('Listening on')) {
        started = true;
        clearTimeout(timer);
        const chain = defineChain({
          id: 31337,
          name: 'Anvil',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
        });
        const transport = http(`http://127.0.0.1:${port}`);
        const account = privateKeyToAccount(TEST_PRIVATE_KEY);
        // walletClient has no chain so resolveChain falls through to opts.chain
        // (the SUPPORTED_CHAIN_IDS guard only fires when walletClient.chain is set).
        const publicClient = createPublicClient({ chain, transport });
        const walletClient = createWalletClient({ transport, account });

        const stop = () =>
          new Promise<void>((res) => {
            stopping = true;
            proc.once('exit', () => res());
            proc.kill('SIGTERM');
          });

        resolve({ port, chain, publicClient, walletClient, stop });
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start Anvil ("${ANVIL_BIN}"): ${err.message}. ` +
            `Install Foundry (https://getfoundry.sh) or set ANVIL_BIN=/path/to/anvil.`,
        ),
      );
    });
    proc.on('exit', (code, signal) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`Anvil exited with code ${String(code)} before listening`));
      } else if (!stopping) {
        process.stderr.write(
          `[setup] Anvil (port ${port}) exited unexpectedly: code=${String(code)} signal=${String(signal)}. Subsequent RPC calls will fail.\n`,
        );
      }
    });
  });
}

export function loadArtifact(contractName: string): { abi: Abi; bytecode: Hex } {
  const artifactPath = resolve(CONTRACTS_OUT, `${contractName}.sol/${contractName}.json`);
  let raw: { abi: Abi; bytecode: { object: Hex } };
  try {
    raw = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
      abi: Abi;
      bytecode: { object: Hex };
    };
  } catch (err) {
    throw new Error(
      `loadArtifact: failed to read "${artifactPath}". ` +
        `Run "cd contracts && forge build" first.\nCause: ${String(err)}`,
    );
  }
  if (!raw.bytecode?.object) {
    throw new Error(
      `loadArtifact: ${contractName} artifact has no bytecode. ` +
        `Verify the contract compiled successfully.`,
    );
  }
  return { abi: raw.abi, bytecode: raw.bytecode.object };
}

export interface MockAddresses {
  pool: Address;
  oracle: Address;
  usdc: Address;
  aUsdc: Address;
  debtUsdc: Address;
  sUsde: Address;
  aSUsde: Address;
  rewardsController: Address;
  wmnt: Address; // reward token used by MockRewardsController
}

const USDC_PRICE_USD8 = 1_00_000_000n; // $1.00 with 8 decimals
const SUSDE_PRICE_USD8 = 1_10_000_000n; // $1.10 with 8 decimals

const mockPoolInitAbi = parseAbi([
  'function mockInitReserve(address asset, uint8 decimals_, address aToken, address debtToken, uint128 supplyRateBps, uint128 borrowRateBps, uint16 ltvBps, uint16 liquidationThresholdBps, bool borrowingEnabled, uint8 eModeCategoryId) external',
  'function mockSetEmodeCategory(uint8 catId, uint16 ltvBps, uint16 ltBps, uint16 bonusBps, string calldata label) external',
]);

const mockOracleSetPriceAbi = parseAbi([
  'function setAssetPrice(address asset, uint256 priceUsd8) external',
]);

const mockMintAbi = parseAbi(['function mint(address to, uint256 amount) external']);

const mockRewardsSetAbi = parseAbi([
  'function mockSetReward(address token, uint256 amount) external',
]);

export async function deployMocks(anvil: AnvilInstance): Promise<MockAddresses> {
  const { publicClient, walletClient } = anvil;
  const oracleArtifact = loadArtifact('MockAaveOracle');
  const poolArtifact = loadArtifact('MockAavePool');
  const usdcArtifact = loadArtifact('MockUSDC');
  const sUsdeArtifact = loadArtifact('MockSUSDe');
  const wmntArtifact = loadArtifact('MockWMNT');
  const rewardsArtifact = loadArtifact('MockRewardsController');

  const account = privateKeyToAccount(TEST_PRIVATE_KEY);

  async function deploy(artifact: { abi: unknown[]; bytecode: Hex }, args: unknown[] = []) {
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
      account,
      chain: anvil.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted' || !receipt.contractAddress) {
      throw new Error(`deploy: contract deployment reverted or produced no address (tx ${hash})`);
    }
    return receipt.contractAddress as Address;
  }

  async function writeAndConfirm(
    address: Address,
    abi: ReturnType<typeof parseAbi>,
    functionName: string,
    args: unknown[],
    label: string,
  ) {
    const hash = await walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account,
      chain: anvil.chain,
    } as Parameters<typeof walletClient.writeContract>[0]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') {
      throw new Error(`deployMocks: ${label} reverted (tx ${hash})`);
    }
  }

  // Deploy oracle (admin = TEST_ACCOUNT)
  const oracle = await deploy(oracleArtifact, [TEST_ACCOUNT]);
  // Deploy pool (oracle + admin)
  const pool = await deploy(poolArtifact, [oracle, TEST_ACCOUNT]);
  // Deploy ERC-20 tokens (underlying + aToken + debtToken per asset)
  const usdc = await deploy(usdcArtifact, [TEST_ACCOUNT]);
  const aUsdc = await deploy(usdcArtifact, [TEST_ACCOUNT]);
  const debtUsdc = await deploy(usdcArtifact, [TEST_ACCOUNT]);
  const sUsde = await deploy(sUsdeArtifact, [TEST_ACCOUNT]);
  const aSUsde = await deploy(sUsdeArtifact, [TEST_ACCOUNT]);
  // Deploy reward token (WMNT) and rewards controller
  const wmnt = await deploy(wmntArtifact, [TEST_ACCOUNT]);
  const rewardsController = await deploy(rewardsArtifact, [TEST_ACCOUNT]);

  // Set oracle prices
  for (const [asset, price] of [
    [usdc, USDC_PRICE_USD8],
    [aUsdc, USDC_PRICE_USD8],
    [sUsde, SUSDE_PRICE_USD8],
    [aSUsde, SUSDE_PRICE_USD8],
  ] as [Address, bigint][]) {
    await writeAndConfirm(
      oracle,
      mockOracleSetPriceAbi,
      'setAssetPrice',
      [asset, price],
      `setAssetPrice(${asset})`,
    );
  }

  // Initialize USDC reserve: ltv=7500bps, lt=8000bps, borrowingEnabled=true, eMode=0
  await writeAndConfirm(
    pool,
    mockPoolInitAbi,
    'mockInitReserve',
    [usdc, 6, aUsdc, debtUsdc, 300, 500, 7500, 8000, true, 0],
    'mockInitReserve(usdc)',
  );

  // Initialize sUSDe reserve: ltv=0 in general mode, lt=8500bps, borrowingEnabled=false, eMode=1
  await writeAndConfirm(
    pool,
    mockPoolInitAbi,
    'mockInitReserve',
    [sUsde, 18, aSUsde, aSUsde, 200, 0, 0, 8500, false, 1],
    'mockInitReserve(sUsde)',
  );

  // E-Mode category 1 (sUSDe/USDC): ltv=9200bps, lt=9400bps
  await writeAndConfirm(
    pool,
    mockPoolInitAbi,
    'mockSetEmodeCategory',
    [1, 9200, 9400, 10500, 'sUSDe / stablecoins'],
    'mockSetEmodeCategory(1)',
  );

  // Configure rewards controller: 10 WMNT per claim
  await writeAndConfirm(
    rewardsController,
    mockRewardsSetAbi,
    'mockSetReward',
    [wmnt, 10n * 10n ** 18n],
    'mockSetReward(wmnt)',
  );
  // Pre-mint WMNT to rewardsController so claimAllRewards can transfer to claimants.
  // 1M WMNT gives headroom for long test suites without running the controller dry.
  await writeAndConfirm(
    wmnt,
    mockMintAbi,
    'mint',
    [rewardsController, 1_000_000n * 10n ** 18n],
    'mint(wmnt → rewardsController)',
  );

  // Pre-mint tokens to test wallet for actions that need an existing balance
  for (const token of [usdc, sUsde]) {
    await writeAndConfirm(
      token,
      mockMintAbi,
      'mint',
      [TEST_ACCOUNT, 1_000_000_000_000n], // 1M tokens
      `mint(${token}, TEST_ACCOUNT)`,
    );
  }

  return { pool, oracle, usdc, aUsdc, debtUsdc, sUsde, aSUsde, rewardsController, wmnt };
}

export async function mintToken(
  anvil: AnvilInstance,
  token: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  const hash = await anvil.walletClient.writeContract({
    address: token,
    abi: mockMintAbi,
    functionName: 'mint',
    args: [to, amount],
    account: privateKeyToAccount(TEST_PRIVATE_KEY),
    chain: anvil.chain,
  });
  const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(
      `mintToken: mint(${to}, ${amount}) on token ${token} reverted (tx ${hash}). Verify the test account has minting privileges.`,
    );
  }
}
