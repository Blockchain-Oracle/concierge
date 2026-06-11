import { parseAbi } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAaveV3MantleProvider } from '../../provider.ts';
import {
  type AnvilInstance,
  deployMocks,
  type MockAddresses,
  startAnvil,
  TEST_ACCOUNT,
} from '../setup.ts';

const balanceOfAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

let anvil: AnvilInstance;
let mocks: MockAddresses;
let claimRewards: ReturnType<typeof createAaveV3MantleProvider>['actions']['claimRewards'];

beforeAll(async () => {
  anvil = await startAnvil();
  mocks = await deployMocks(anvil);

  const provider = createAaveV3MantleProvider({
    walletClient: anvil.walletClient,
    publicClient: anvil.publicClient,
    chain: anvil.chain,
    addresses: {
      pool: mocks.pool,
      oracle: mocks.oracle,
      sUsde: mocks.sUsde,
      incentivesController: mocks.rewardsController,
    },
  });
  claimRewards = provider.actions.claimRewards;
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe('claimRewards action', () => {
  it('happy path: rewardsList contains wmnt, claimedAmounts[0] === 10 WMNT, balance increases', async () => {
    const preBal = await anvil.publicClient.readContract({
      address: mocks.wmnt,
      abi: balanceOfAbi,
      functionName: 'balanceOf',
      args: [TEST_ACCOUNT],
    });

    const result = await claimRewards.invoke({
      assets: [mocks.aUsdc],
      to: TEST_ACCOUNT,
    });

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.rewardsList[0]?.toLowerCase()).toBe(mocks.wmnt.toLowerCase());
    expect(BigInt(result.claimedAmounts[0])).toBe(10n * 10n ** 18n);

    const postBal = await anvil.publicClient.readContract({
      address: mocks.wmnt,
      abi: balanceOfAbi,
      functionName: 'balanceOf',
      args: [TEST_ACCOUNT],
    });
    expect(postBal - preBal).toBe(10n * 10n ** 18n);
  });

  it('attestation payload has correct schema', async () => {
    const result = await claimRewards.invoke({
      assets: [mocks.aUsdc],
      to: TEST_ACCOUNT,
    });

    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.claimRewards.v1');
  });

  it('throws NetworkUnsupported when incentivesController is not configured', async () => {
    const { ConciergeError } = await import('@concierge/sdk');

    // Anvil chainId=31337 — provider leaves incentivesControllerAddress=undefined unless passed.
    const provider = createAaveV3MantleProvider({
      walletClient: anvil.walletClient,
      publicClient: anvil.publicClient,
      chain: anvil.chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    });

    const err = await provider.actions.claimRewards
      .invoke({ assets: [mocks.aUsdc], to: TEST_ACCOUNT })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('NetworkUnsupported');
  });

  it('throws ConfigError when no walletClient is provided', async () => {
    const { ConciergeError } = await import('@concierge/sdk');

    const provider = createAaveV3MantleProvider({
      publicClient: anvil.publicClient,
      chain: anvil.chain,
      addresses: {
        pool: mocks.pool,
        oracle: mocks.oracle,
        sUsde: mocks.sUsde,
        incentivesController: mocks.rewardsController,
      },
    });

    const err = await provider.actions.claimRewards
      .invoke({ assets: [mocks.aUsdc], to: TEST_ACCOUNT })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('ConfigError');
  });
});
