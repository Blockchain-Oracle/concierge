// Anvil process management for mantle-dex integration tests.
// Forks Mantle Mainnet to run real DEX quote calls against live contract state.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { Address } from '@concierge/shared';
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  type PublicClient,
  parseAbiParameters,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const MANTLE_MAINNET_RPC = process.env['MANTLE_RPC_URL'] ?? 'https://rpc.mantle.xyz';
const ANVIL_BIN = process.env['ANVIL_BIN'] ?? 'anvil';

// Deterministic Anvil test account #0 — 10k ETH, unlocked.
export const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

export interface AnvilFork {
  readonly port: number;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly stop: () => Promise<void>;
  /** Directly write an ERC-20 balance via anvil_setStorageAt (no approval needed). */
  readonly setErc20Balance: (
    token: Address,
    account: Address,
    amount: bigint,
    mappingSlot: number,
  ) => Promise<void>;
}

// ERC-20 balance slot keys differ by implementation (verified via cast storage):
// - Circle FiatToken (USDC on Mantle): mapping at slot 9
// - Ethena USDe on Mantle: mapping at slot 5
export const TOKEN_BALANCE_SLOTS: Record<string, number> = {
  '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9': 9, // USDC (Circle FiatToken)
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34': 5, // USDe (Ethena bridged)
};

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

export async function startAnvilFork(): Promise<AnvilFork> {
  const port = await getFreePort();

  return new Promise((resolve, reject) => {
    const proc = spawn(ANVIL_BIN, ['--port', String(port), '--fork-url', MANTLE_MAINNET_RPC], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let stopping = false;
    const buf: string[] = [];

    const timer = setTimeout(() => {
      if (!started) {
        proc.kill('SIGTERM');
        reject(
          new Error(
            `Anvil fork startup timed out after 30s. Install Foundry (https://getfoundry.sh) or set ANVIL_BIN=/path/to/anvil.`,
          ),
        );
      }
    }, 30_000);

    const onData = (chunk: Buffer) => {
      buf.push(chunk.toString());
      if (!started && buf.join('').includes('Listening on')) {
        started = true;
        clearTimeout(timer);
        const chain = defineChain({
          id: 5000,
          name: 'Anvil (Mantle fork)',
          nativeCurrency: { name: 'MNT', symbol: 'MNT', decimals: 18 },
          rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
        });
        const transport = http(`http://127.0.0.1:${port}`);
        const account = privateKeyToAccount(TEST_PRIVATE_KEY);
        const publicClient = createPublicClient({ chain, transport });
        const walletClient = createWalletClient({ transport, account });
        const stop = () =>
          new Promise<void>((res) => {
            stopping = true;
            proc.once('exit', () => res());
            proc.kill('SIGTERM');
          });

        const setErc20Balance = async (
          token: Address,
          account: Address,
          amount: bigint,
          mappingSlot: number,
        ) => {
          if (!Number.isInteger(mappingSlot) || mappingSlot < 0 || mappingSlot > 0xffff) {
            throw new RangeError(
              `setErc20Balance: mappingSlot must be a non-negative integer ≤ 65535, got ${mappingSlot}`,
            );
          }
          // slot = keccak256(abi.encode(account, mappingSlot))
          const storageKey = keccak256(
            encodeAbiParameters(parseAbiParameters('address, uint256'), [
              account,
              BigInt(mappingSlot),
            ]),
          );
          const value = `0x${amount.toString(16).padStart(64, '0')}` as `0x${string}`;
          await publicClient.request({
            // @ts-expect-error anvil_setStorageAt is not in viem's standard type list
            method: 'anvil_setStorageAt',
            params: [token, storageKey, value],
          });
          // Verify the write landed — a wrong mappingSlot produces a silent zero-balance.
          const actual = await publicClient.readContract({
            address: token,
            abi: [
              {
                name: 'balanceOf',
                type: 'function',
                inputs: [{ name: '', type: 'address' }],
                outputs: [{ name: '', type: 'uint256' }],
                stateMutability: 'view',
              },
            ] as const,
            functionName: 'balanceOf',
            args: [account],
          });
          if (actual < amount) {
            throw new Error(
              `[setup] setErc20Balance: write failed for ${token}: expected ≥ ${amount}, got ${actual}. Slot ${mappingSlot} may be wrong.`,
            );
          }
        };

        resolve({ port, chain, publicClient, walletClient, stop, setErc20Balance });
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Anvil fork: ${err.message}`));
    });
    proc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`Anvil exited with code ${String(code)} before listening`));
      } else if (!stopping) {
        process.stderr.write(`[setup] Anvil fork exited unexpectedly: code=${String(code)}\n`);
      }
    });
  });
}
