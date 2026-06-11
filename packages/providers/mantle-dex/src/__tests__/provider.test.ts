import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { ATTESTATION_SCHEMAS } from '../attestation.ts';
import { createMantleDexProvider } from '../provider.ts';

describe('createMantleDexProvider', () => {
  it('exposes exactly two actions in alphabetical order', () => {
    const p = createMantleDexProvider({ chain: 'mantle-mainnet' });
    expect(Object.keys(p.actions).sort()).toEqual(['quote', 'swap']);
  });

  it('sets chainId=5000 for mantle-mainnet', () => {
    const p = createMantleDexProvider({ chain: 'mantle-mainnet' });
    expect(p.chainId).toBe(5000);
  });

  it('sets chainId=5003 for mantle-sepolia', () => {
    const p = createMantleDexProvider({ chain: 'mantle-sepolia' });
    expect(p.chainId).toBe(5003);
  });

  it('defaults to mainnet when no options given', () => {
    const p = createMantleDexProvider();
    expect(p.chainId).toBe(5000);
  });

  it('infers sepolia from rpcUrl containing "sepolia"', () => {
    const p = createMantleDexProvider({ rpcUrl: 'https://rpc.sepolia.mantle.xyz' });
    expect(p.chainId).toBe(5003);
  });

  it('returns a frozen provider object', () => {
    const p = createMantleDexProvider({ chain: 'mantle-mainnet' });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.actions)).toBe(true);
  });

  it('each action has name, description, inputSchema, outputSchema', () => {
    const p = createMantleDexProvider({ chain: 'mantle-mainnet' });
    for (const action of Object.values(p.actions)) {
      expect(typeof action.name).toBe('string');
      expect(typeof action.description).toBe('string');
      expect(action.inputSchema).toBeDefined();
      expect(action.outputSchema).toBeDefined();
    }
  });

  it('throws NetworkUnsupported for a non-Mantle walletClient chain', async () => {
    const { createWalletClient, http, defineChain } = await import('viem');
    const notMantle = defineChain({
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://eth.llamarpc.com'] } },
    });
    const wc = createWalletClient({ chain: notMantle, transport: http() });
    expect(() => createMantleDexProvider({ walletClient: wc })).toThrow(ConciergeError);
  });
});

describe('attestation schemas', () => {
  it('contains the correct schema strings for all 5 venues', () => {
    expect(ATTESTATION_SCHEMAS.merchantMoe).toBe('concierge.mantle-dex.merchantMoe.swap.v1');
    expect(ATTESTATION_SCHEMAS.agni).toBe('concierge.mantle-dex.agni.swap.v1');
    expect(ATTESTATION_SCHEMAS.fusionx).toBe('concierge.mantle-dex.fusionx.swap.v1');
    expect(ATTESTATION_SCHEMAS.woofi).toBe('concierge.mantle-dex.woofi.swap.v1');
    expect(ATTESTATION_SCHEMAS.lifi).toBe('concierge.mantle-dex.lifi.swap.v1');
  });
});
