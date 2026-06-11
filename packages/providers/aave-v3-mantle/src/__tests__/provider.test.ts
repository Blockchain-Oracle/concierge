import { ConciergeError } from '@concierge/sdk';
import { mantleSepolia } from '@concierge/shared';
import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';
import { createAaveV3MantleProvider } from '../provider.ts';

describe('createAaveV3MantleProvider', () => {
  it('exposes exactly six actions in alphabetical order', () => {
    const p = createAaveV3MantleProvider({ chain: 'mantle-sepolia' });
    expect(Object.keys(p.actions).sort()).toEqual([
      'borrow',
      'claimRewards',
      'repay',
      'setUserEMode',
      'supply',
      'withdraw',
    ]);
  });

  it('sets chainId=5000 for mantle-mainnet', () => {
    const p = createAaveV3MantleProvider({ chain: 'mantle-mainnet' });
    expect(p.chainId).toBe(5000);
  });

  it('sets chainId=5003 for mantle-sepolia', () => {
    const p = createAaveV3MantleProvider({ chain: 'mantle-sepolia' });
    expect(p.chainId).toBe(5003);
  });

  it('defaults to mainnet when no chain or rpcUrl is given', () => {
    const p = createAaveV3MantleProvider();
    expect(p.chainId).toBe(5000);
  });

  it('infers sepolia from rpcUrl containing "sepolia"', () => {
    const p = createAaveV3MantleProvider({ rpcUrl: 'https://rpc.sepolia.mantle.xyz' });
    expect(p.chainId).toBe(5003);
  });

  it('accepts a custom publicClient and keeps chainId from chain option', () => {
    const publicClient = createPublicClient({
      chain: mantleSepolia,
      transport: http('https://rpc.sepolia.mantle.xyz'),
    });
    const p = createAaveV3MantleProvider({ publicClient, chain: 'mantle-sepolia' });
    expect(p.chainId).toBe(5003);
  });

  it('returns a frozen provider object (immutable shape)', () => {
    const p = createAaveV3MantleProvider({ chain: 'mantle-sepolia' });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.actions)).toBe(true);
  });

  it('throws NetworkUnsupported for an unsupported walletClient chainId', async () => {
    const { createWalletClient, http: viemHttp } = await import('viem');
    const { defineChain } = await import('viem');
    const notMantle = defineChain({
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://eth.llamarpc.com'] } },
    });
    const wc = createWalletClient({ chain: notMantle, transport: viemHttp() });
    expect(() => createAaveV3MantleProvider({ walletClient: wc })).toThrow(ConciergeError);
  });

  it('each action has name, description, inputSchema, outputSchema', () => {
    const p = createAaveV3MantleProvider({ chain: 'mantle-mainnet' });
    for (const action of Object.values(p.actions)) {
      expect(typeof action.name).toBe('string');
      expect(typeof action.description).toBe('string');
      expect(action.inputSchema).toBeDefined();
      expect(action.outputSchema).toBeDefined();
    }
  });
});
