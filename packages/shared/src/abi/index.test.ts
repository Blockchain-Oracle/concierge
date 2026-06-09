// ABI sanity tests — selector pinning catches every parseAbi typo at once.

import type { AbiFunction } from 'viem';
import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  erc20Abi,
  iaaveOracleAbi,
  identityRegistryAbi,
  ipoolAbi,
  kernelAbi,
  reputationRegistryAbi,
} from './index.ts';

function findFn(abi: readonly unknown[], name: string): AbiFunction | undefined {
  return abi.find(
    (e): e is AbiFunction =>
      typeof e === 'object' &&
      e !== null &&
      (e as { type?: unknown }).type === 'function' &&
      (e as { name?: unknown }).name === name,
  );
}

// Canonical Aave V3 selectors (verified against IPool source — aave-v3-origin).
const AAVE_SELECTORS: Record<string, `0x${string}`> = {
  supply: '0x617ba037',
  borrow: '0xa415bcad',
  repay: '0x573ade81',
  withdraw: '0x69328dec',
  setUserEMode: '0x28530a47',
  getUserAccountData: '0xbf92857c',
  getReserveData: '0x35ea6a75',
  getEModeCategoryData: '0x6c6f6ae1',
};

describe('Aave V3 IPool ABI', () => {
  it.each(Object.entries(AAVE_SELECTORS))(
    '%s selector matches canonical',
    (name, selector) => {
      const fn = findFn(ipoolAbi, name);
      expect(fn, `IPool.${name} missing`).toBeDefined();
      expect(toFunctionSelector(fn as AbiFunction)).toBe(selector);
    },
  );

  it('IAaveOracle.getAssetPrice selector matches canonical', () => {
    const fn = findFn(iaaveOracleAbi, 'getAssetPrice');
    expect(fn).toBeDefined();
    expect(toFunctionSelector(fn as AbiFunction)).toBe('0xb3596f07');
  });
});

describe('ERC-20 ABI', () => {
  it.each(['balanceOf', 'transfer', 'approve', 'allowance', 'decimals', 'symbol'])(
    'exports %s',
    (name) => {
      expect(findFn(erc20Abi, name), `ERC20.${name} missing`).toBeDefined();
    },
  );
});

describe('ZeroDev Kernel ABI', () => {
  it('exports execute(bytes32 mode, bytes executionCalldata)', () => {
    const fn = findFn(kernelAbi, 'execute');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map((i) => i.type)).toEqual(['bytes32', 'bytes']);
  });

  it('does NOT export executeBatch (Kernel v3.1 batches via ExecMode word in execute)', () => {
    expect(findFn(kernelAbi, 'executeBatch')).toBeUndefined();
  });
});

describe('ERC-8004 IdentityRegistry ABI', () => {
  it('exposes 3 register overloads with the expected signatures', () => {
    const registers = identityRegistryAbi.filter(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: unknown }).type === 'function' &&
        (e as { name?: unknown }).name === 'register',
    ) as ReadonlyArray<AbiFunction>;
    expect(registers.length).toBe(3);
    const inputShapes = registers.map((r) => r.inputs.map((i) => i.type)).sort();
    expect(inputShapes).toEqual([[], ['string'], ['string', 'tuple[]']]);
  });

  it('exports setAgentWallet (EIP-712 wallet binding)', () => {
    expect(findFn(identityRegistryAbi, 'setAgentWallet')).toBeDefined();
  });
});

describe('ERC-8004 ReputationRegistry ABI', () => {
  it('giveFeedback pins the exact 8-arg tuple (uint256, int128, uint8, string×4, bytes32)', () => {
    const fn = findFn(reputationRegistryAbi, 'giveFeedback');
    expect(fn).toBeDefined();
    expect(fn?.inputs.map((i) => i.type)).toEqual([
      'uint256',
      'int128',
      'uint8',
      'string',
      'string',
      'string',
      'string',
      'bytes32',
    ]);
  });

  it('exports getSummary (aggregated reputation read)', () => {
    expect(findFn(reputationRegistryAbi, 'getSummary')).toBeDefined();
  });
});
