// Anvil process management for ethena-susde integration tests.
// Forks Mantle Mainnet to run real WooFi swap and Aave oracle calls against live contract state.

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
import { vi } from 'vitest';

export const MANTLE_MAINNET_RPC = process.env['MANTLE_RPC_URL'] ?? 'https://rpc.mantle.xyz';
const ANVIL_BIN = process.env['ANVIL_BIN'] ?? 'anvil';

// Deterministic Anvil test account #0 — 10k MNT, unlocked.
export const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

// Storage slot mapping verified via `cast storage <addr> <slot> --rpc-url https://rpc.mantle.xyz`:
// Both USDe and sUSDe on Mantle are Ethena LayerZero V2 OFT — same contract template → slot 5.
// USDC uses Circle's FiatToken architecture → slot 9.
export const TOKEN_BALANCE_SLOTS: Record<string, number> = {
  '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9': 9, // USDC (Circle FiatToken)
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34': 5, // USDe (Ethena LayerZero OFT)
  '0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2': 5, // sUSDe (Ethena LayerZero OFT)
};

export interface AnvilFork {
  readonly port: number;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly stop: () => Promise<void>;
  readonly setErc20Balance: (
    token: Address,
    account: Address,
    amount: bigint,
    mappingSlot: number,
  ) => Promise<void>;
  readonly drainContract: (addr: Address) => Promise<void>;
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
            `Anvil fork startup timed out after 30s. Install Foundry (https://getfoundry.sh) or set ANVIL_BIN.`,
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
          if (actual !== amount) {
            throw new Error(
              `[setup] setErc20Balance: write failed for ${token}: expected ${amount}, got ${actual}. ` +
                `Slot ${mappingSlot} may be wrong — try another slot index.`,
            );
          }
        };

        const drainContract = async (addr: Address) => {
          await publicClient.request({
            // @ts-expect-error anvil_setCode is not in viem's standard type list
            method: 'anvil_setCode',
            params: [addr, '0xfd'],
          });
        };

        resolve({ port, chain, publicClient, walletClient, stop, setErc20Balance, drainContract });
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

/** Stubs the Ethena yields API while passing all other fetch requests through.
 * Uses vi.stubGlobal so vi.unstubAllGlobals() in afterEach properly restores fetch. */
export function stubEthenaApi(susdeYieldPct: number): void {
  const pct = susdeYieldPct;
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('ethena.fi')) {
        return new Response(JSON.stringify({ data: { protocol: pct, staking: pct } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Pass all other requests through (e.g., viem JSON-RPC to Anvil fork).
      return realFetch(input, init);
    },
  );
}
