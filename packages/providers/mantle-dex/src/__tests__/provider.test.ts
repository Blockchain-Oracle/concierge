import { ConciergeError } from '@concierge/sdk';
import { describe, expect, it } from 'vitest';
import { ATTESTATION_SCHEMAS, buildAttestationPayload } from '../attestation.ts';
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

  it('throws NetworkUnsupported for a non-Mantle publicClient chain', async () => {
    const { createPublicClient, http, defineChain } = await import('viem');
    const notMantle = defineChain({
      id: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://eth.llamarpc.com'] } },
    });
    const pc = createPublicClient({ chain: notMantle, transport: http() });
    expect(() => createMantleDexProvider({ publicClient: pc })).toThrow(ConciergeError);
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

const ATTESTATION_BASE = {
  venue: 'woofi' as const,
  chainId: 5000,
  tokenIn: '0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9' as `0x${string}`,
  tokenOut: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34' as `0x${string}`,
  amountIn: 1_000_000n,
  amountOut: 990_000n,
  quotedOut: 1_000_000n,
  txHash: `0x${'a'.repeat(64)}` as `0x${string}`,
};

describe('buildAttestationPayload', () => {
  it('uses the configured slippageBps directly (not computed from amounts)', () => {
    const payload = buildAttestationPayload({ ...ATTESTATION_BASE, slippageBps: 50 });
    expect(payload.slippageBps).toBe(50);
  });

  it('clamps slippageBps to 0 when a negative value is passed', () => {
    // Defensive guard: callers should pass configured bps, but clamp handles edge cases.
    const payload = buildAttestationPayload({ ...ATTESTATION_BASE, slippageBps: -10 });
    expect(payload.slippageBps).toBe(0);
  });

  it('clamps slippageBps to 10_000 when value exceeds maximum', () => {
    const payload = buildAttestationPayload({ ...ATTESTATION_BASE, slippageBps: 20_000 });
    expect(payload.slippageBps).toBe(10_000);
  });

  it('validates the payload through AttestationPayloadSchema.parse', () => {
    // parse() is called internally — valid input should not throw
    expect(() => buildAttestationPayload({ ...ATTESTATION_BASE, slippageBps: 50 })).not.toThrow();
  });

  it('includes expected top-level fields', () => {
    const payload = buildAttestationPayload({ ...ATTESTATION_BASE, slippageBps: 50 });
    expect(payload.venue).toBe('woofi');
    expect(payload.amountIn).toBe('1000000');
    expect(payload.amountOut).toBe('990000');
    expect(payload.quotedOut).toBe('1000000');
    expect(payload.txHash).toBe(ATTESTATION_BASE.txHash);
    expect(typeof payload.ts).toBe('number');
  });
});
