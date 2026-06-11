import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAaveV3MantleProvider } from '../../provider.ts';
import { getUserAccountData } from '../../selectors.ts';
import {
  type AnvilInstance,
  deployMocks,
  type MockAddresses,
  startAnvil,
  TEST_ACCOUNT,
} from '../setup.ts';

let anvil: AnvilInstance;
let mocks: MockAddresses;
let supply: ReturnType<typeof createAaveV3MantleProvider>['actions']['supply'];

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
    },
  });
  supply = provider.actions.supply;
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe('supply action', () => {
  it('happy path: supply USDC → collateral increases, txHash is 32-byte hex', async () => {
    const preBal = await getUserAccountData(anvil.publicClient, mocks.pool, TEST_ACCOUNT);

    const result = await supply.invoke({ asset: mocks.usdc, amount: '100000000' }); // 100 USDC

    // txHash is a 32-byte hex string
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Collateral base increased after supply
    const postBal = await getUserAccountData(anvil.publicClient, mocks.pool, TEST_ACCOUNT);
    expect(postBal.totalCollateralBase).toBeGreaterThan(preBal.totalCollateralBase);

    // Attestation payload has correct schema
    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.supply.v1');
    expect(result.attestationPayload.eMode).toBe(0);
  });

  it('supply a second time accumulates collateral (no double-approval error)', async () => {
    const pre = await getUserAccountData(anvil.publicClient, mocks.pool, TEST_ACCOUNT);

    await supply.invoke({ asset: mocks.usdc, amount: '50000000' }); // 50 USDC

    const post = await getUserAccountData(anvil.publicClient, mocks.pool, TEST_ACCOUNT);
    expect(post.totalCollateralBase).toBeGreaterThan(pre.totalCollateralBase);
  });

  it('throws RpcError when pool reverts for an unsupported asset', async () => {
    const { ConciergeError } = await import('@concierge/sdk');
    // Address not initialized in MockAavePool → AssetNotSupported revert
    const fakeAsset = '0x1111111111111111111111111111111111111111';
    const err = await supply.invoke({ asset: fakeAsset, amount: '1000000' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConciergeError);
    expect((err as InstanceType<typeof ConciergeError>).type).toBe('RpcError');
  });

  it('attestation payload passes schema validation', async () => {
    const { AttestationPayloadSchema } = await import('../../attestation.ts');
    const result = await supply.invoke({ asset: mocks.usdc, amount: '10000000' }); // 10 USDC
    const parsed = AttestationPayloadSchema.safeParse(result.attestationPayload);
    expect(parsed.success).toBe(true);
  });

  it('throws ConfigError when no walletClient is configured', async () => {
    const { ConciergeError } = await import('@concierge/sdk');
    const readOnlyProvider = createAaveV3MantleProvider({
      publicClient: anvil.publicClient,
      chain: anvil.chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    });
    await expect(
      readOnlyProvider.actions.supply.invoke({ asset: mocks.usdc, amount: '1000000' }),
    ).rejects.toThrow(ConciergeError);
  });
});
