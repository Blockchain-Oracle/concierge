import { ADDRESSES } from '@concierge/shared';
import { describe, expect, it } from 'vitest';
import { createErc8004Provider } from '../provider.ts';

describe('createErc8004Provider — action surface', () => {
  it('returns all 4 actions sorted correctly', () => {
    const provider = createErc8004Provider({ chain: 'mantle-mainnet' });
    expect(Object.keys(provider.actions).sort()).toStrictEqual([
      'attestAction',
      'readFeedback',
      'readReputation',
      'registerAgent',
    ]);
  });
});

describe('createErc8004Provider — address resolution', () => {
  it('resolves canonical Mainnet addresses (5000)', () => {
    const provider = createErc8004Provider({ chain: 'mantle-mainnet' });
    expect(provider.chainId).toBe(5000);
    expect(provider.identityRegistry).toBe(ADDRESSES.mantleMainnet.erc8004.identityRegistry);
    expect(provider.reputationRegistry).toBe(ADDRESSES.mantleMainnet.erc8004.reputationRegistry);
    expect(provider.identityRegistry).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(provider.reputationRegistry).toBe('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63');
  });

  it('resolves canonical Sepolia addresses (5003)', () => {
    const provider = createErc8004Provider({ chain: 'mantle-sepolia' });
    expect(provider.chainId).toBe(5003);
    expect(provider.identityRegistry).toBe(ADDRESSES.mantleSepolia.erc8004.identityRegistry);
    expect(provider.reputationRegistry).toBe(ADDRESSES.mantleSepolia.erc8004.reputationRegistry);
    expect(provider.identityRegistry).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    expect(provider.reputationRegistry).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
  });

  it('defaults to mantle-mainnet when chain is omitted', () => {
    const provider = createErc8004Provider();
    expect(provider.chainId).toBe(5000);
  });

  it('accepts address overrides', () => {
    const id = '0xDeadDeadDeadDeadDeadDeadDeadDeadDeadDead' as `0x${string}`;
    const provider = createErc8004Provider({ identityRegistry: id });
    expect(provider.identityRegistry).toBe(id);
  });
});
