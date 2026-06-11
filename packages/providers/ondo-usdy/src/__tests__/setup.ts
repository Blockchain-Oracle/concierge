// Anvil process management for ondo-usdy integration tests.
// Forks Mantle Mainnet to run real Agni pool queries and blocklist reads.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { type Chain, createPublicClient, defineChain, http, type PublicClient } from 'viem';

export const MANTLE_MAINNET_RPC = process.env['MANTLE_RPC_URL'] ?? 'https://rpc.mantle.xyz';
const ANVIL_BIN = process.env['ANVIL_BIN'] ?? 'anvil';

// Block 96_500_000 ≈ 2026-06-10, Agni USDY/USDC pool ~5 days old (<7 days TWAP history).
// Pinning ensures getYieldRate fork tests remain deterministic (pool never "matures" mid-test).
export const FORK_BLOCK = 96_500_000;

// Known USDY holder on Mantle Mainnet (verified 2026-06-11, ~278,835 USDY).
export const KNOWN_USDY_HOLDER = '0xd8169f099ce16c87a99d2a8494023574b5eea9c5' as const;

export interface AnvilFork {
  readonly port: number;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
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

export async function startAnvilFork(forkBlock?: number): Promise<AnvilFork> {
  const port = await getFreePort();
  const blockArgs = forkBlock !== undefined ? ['--fork-block-number', String(forkBlock)] : [];

  return new Promise((resolve, reject) => {
    const proc = spawn(
      ANVIL_BIN,
      ['--port', String(port), '--fork-url', MANTLE_MAINNET_RPC, ...blockArgs],
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
        const publicClient = createPublicClient({ chain, transport });
        const stop = () =>
          new Promise<void>((res) => {
            stopping = true;
            proc.once('exit', () => res());
            proc.kill('SIGTERM');
          });
        resolve({ port, chain, publicClient, stop });
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
