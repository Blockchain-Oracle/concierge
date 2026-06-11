// Fork integration tests for selectors — reads real on-chain state from a Mantle Mainnet fork.
import { ADDRESSES } from '@concierge/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBalanceSusde, getBalanceUSDe, getPriceUSD } from '../selectors.ts';
import { type AnvilFork, startAnvilFork, TEST_ACCOUNT, TOKEN_BALANCE_SLOTS } from './setup.ts';

const { USDe, sUSDe } = ADDRESSES.mantleMainnet.tokens;
const { oracle } = ADDRESSES.mantleMainnet.aave;

const SEED_USDE = 250_000_000_000_000_000_000n; // 250 USDe
const SEED_SUSDE = 200_000_000_000_000_000_000n; // 200 sUSDe

let fork: AnvilFork;

beforeAll(async () => {
  fork = await startAnvilFork();
  const usdeSlot = TOKEN_BALANCE_SLOTS[USDe.toLowerCase()];
  const susdeSlot = TOKEN_BALANCE_SLOTS[sUSDe.toLowerCase()];
  if (usdeSlot === undefined || susdeSlot === undefined)
    throw new Error('balance slot not configured');
  await fork.setErc20Balance(USDe, TEST_ACCOUNT, SEED_USDE, usdeSlot);
  await fork.setErc20Balance(sUSDe, TEST_ACCOUNT, SEED_SUSDE, susdeSlot);
}, 60_000);

afterAll(async () => {
  await fork.stop();
});

describe('getBalanceUSDe — fork', () => {
  it('reads seeded USDe balance from Mantle mainnet fork', async () => {
    const balance = await getBalanceUSDe(fork.publicClient, USDe, TEST_ACCOUNT);
    expect(balance).toBe(SEED_USDE);
  }, 30_000);
});

describe('getBalanceSusde — fork', () => {
  it('reads seeded sUSDe balance from Mantle mainnet fork', async () => {
    const balance = await getBalanceSusde(fork.publicClient, sUSDe, TEST_ACCOUNT);
    expect(balance).toBe(SEED_SUSDE);
  }, 30_000);
});

describe('getPriceUSD — fork', () => {
  it('returns positive sUSDe price from real Aave oracle on Mantle', async () => {
    const price = await getPriceUSD(fork.publicClient, oracle, sUSDe);
    // Real Aave oracle reports sUSDe price in 1e8 USD units (~$1.20+ typically).
    expect(price).toBeGreaterThan(100_000_000n); // > $1.00
    expect(price).toBeLessThan(200_000_000n); // < $2.00 (sanity upper bound)
  }, 30_000);
});
