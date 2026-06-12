import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { Address } from '@concierge/shared';
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const MANTLE_SEPOLIA_RPC =
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
  process.env['MANTLE_SEPOLIA_RPC_URL'] ?? 'https://rpc.sepolia.mantle.xyz';
// biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
const ANVIL_BIN = process.env['ANVIL_BIN'] ?? 'anvil';

// ERC-8004 canonical addresses on Mantle Sepolia (verified 2026-06-04)
export const IDENTITY_REGISTRY_SEPOLIA =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const satisfies Address;
export const REPUTATION_REGISTRY_SEPOLIA =
  '0x8004B663056A597Dffe9eCcC1965A193B7388713' as const satisfies Address;

// Anvil deterministic account #0 — agent owner (registers NFT).
export const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
export const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const satisfies Address;

// Anvil deterministic account #1 — acts as "client" giving feedback.
// ERC-8004 enforces "Self-feedback not allowed": the agent owner cannot call giveFeedback on itself.
// A separate funded account is required to submit attestations against the agent.
export const CLIENT_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const CLIENT_ACCOUNT =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const satisfies Address;

export interface AnvilFork {
  readonly port: number;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  /** walletClient for account #0 — use for registerAgent calls (agent owner). */
  readonly walletClient: WalletClient;
  /** walletClient for account #1 — use for attestAction calls (client giving feedback). */
  readonly clientWalletClient: WalletClient;
  /** The block number at which the fork was created. Use as `fromBlock` for event queries
   *  to avoid the remote RPC's "block range > 10000 max" limit. */
  readonly forkBlockNumber: bigint;
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

export async function startAnvilFork(): Promise<AnvilFork> {
  const port = await getFreePort();

  return new Promise((resolve, reject) => {
    const proc = spawn(
      ANVIL_BIN,
      ['--port', String(port), '--fork-url', MANTLE_SEPOLIA_RPC, '--chain-id', '5003'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let started = false;
    let stopping = false;
    const buf: string[] = [];

    const timer = setTimeout(() => {
      if (!started) {
        proc.kill('SIGTERM');
        reject(
          new Error(
            `Anvil fork startup timed out after 30s. ` +
              `Install Foundry (https://getfoundry.sh) or set ANVIL_BIN=/path/to/anvil.`,
          ),
        );
      }
    }, 30_000);

    const onData = (chunk: Buffer) => {
      buf.push(chunk.toString());
      if (!started && buf.join('').includes('Listening on')) {
        started = true;
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        // Use chain ID 5003 (Mantle Sepolia) so EIP-712 hashes match what the live contracts expect.
        const chain = defineChain({
          id: 5003,
          name: 'Anvil (Mantle Sepolia fork)',
          nativeCurrency: { name: 'MNT', symbol: 'MNT', decimals: 18 },
          rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
        });
        const transport = http(`http://127.0.0.1:${port}`);
        const publicClient = createPublicClient({ chain, transport });
        // Both walletClients have chain binding so writeContract calls work without per-call chain arg.
        const walletClient = createWalletClient({
          chain,
          transport,
          account: privateKeyToAccount(TEST_PRIVATE_KEY),
        });
        const clientWalletClient = createWalletClient({
          chain,
          transport,
          account: privateKeyToAccount(CLIENT_PRIVATE_KEY),
        });

        let stopCalled = false;
        const stop = () => {
          if (stopCalled) return Promise.resolve();
          stopCalled = true;
          stopping = true;
          return new Promise<void>((res) => {
            const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
            proc.once('exit', () => {
              clearTimeout(killTimer);
              res();
            });
            proc.kill('SIGTERM');
          });
        };

        // Capture the current block to use as fromBlock baseline in event queries.
        // Querying from block 0 would ask the remote RPC for the full chain history,
        // hitting Mantle Sepolia's "block range > 10000 max" limit.
        publicClient
          .getBlockNumber()
          .then((forkBlockNumber) => {
            resolve({
              port,
              chain,
              publicClient,
              walletClient,
              clientWalletClient,
              forkBlockNumber,
              stop,
            });
          })
          .catch(reject);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start Anvil fork ("${ANVIL_BIN}"): ${err.message}. ` +
            `Install Foundry (https://getfoundry.sh) or set ANVIL_BIN=/path/to/anvil.`,
        ),
      );
    });
    proc.on('exit', (code, signal) => {
      if (!started) {
        clearTimeout(timer);
        reject(
          new Error(
            `Anvil exited with code ${String(code)} before listening.\nAnvil output:\n${buf.join('')}`,
          ),
        );
      } else if (!stopping) {
        process.stderr.write(
          `[setup] Anvil fork (port ${port}) exited unexpectedly: code=${String(code)} signal=${String(signal)}.\n`,
        );
      }
    });
  });
}
