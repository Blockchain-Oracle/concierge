import type { Address } from '@concierge/shared';
import { createWalletClient, http } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAaveV3MantleProvider } from '../../provider.ts';
import { getUserEMode } from '../../selectors.ts';
import {
  ANVIL_ACCOUNTS,
  type AnvilInstance,
  deployMocks,
  type MockAddresses,
  startAnvil,
  TEST_ACCOUNT,
} from '../setup.ts';

let anvil: AnvilInstance;
let mocks: MockAddresses;
let setUserEMode: ReturnType<typeof createAaveV3MantleProvider>['actions']['setUserEMode'];

beforeAll(async () => {
  anvil = await startAnvil();
  mocks = await deployMocks(anvil);

  const provider = createAaveV3MantleProvider({
    walletClient: anvil.walletClient,
    publicClient: anvil.publicClient,
    chain: anvil.chain,
    addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
  });
  setUserEMode = provider.actions.setUserEMode;
}, 30_000);

afterAll(async () => {
  if (anvil) await anvil.stop();
});

describe('setUserEMode action', () => {
  it('post-state: getUserEMode returns 1 after setUserEMode(1)', async () => {
    await setUserEMode.invoke({ categoryId: 1 });
    const eMode = await getUserEMode(anvil.publicClient, mocks.pool, TEST_ACCOUNT);
    expect(eMode).toBe(1);
  });

  it('can toggle back to 0 (general mode)', async () => {
    await setUserEMode.invoke({ categoryId: 0 });
    const eMode = await getUserEMode(anvil.publicClient, mocks.pool, TEST_ACCOUNT);
    expect(eMode).toBe(0);
  });

  it('txHash is a 32-byte hex string', async () => {
    const result = await setUserEMode.invoke({ categoryId: 1 });
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('attestation payload has correct schema and eMode field', async () => {
    await setUserEMode.invoke({ categoryId: 0 });
    const result = await setUserEMode.invoke({ categoryId: 1 });

    expect(result.attestationPayload.schema).toBe('concierge.aave.v3.setUserEMode.v1');
    expect(result.attestationPayload.eMode).toBe(1);
  });

  it('second account can independently control its own E-Mode', async () => {
    const acct2Addr = ANVIL_ACCOUNTS[0] as Address;
    const { publicClient, chain } = anvil;

    // Put TEST_ACCOUNT in a known state so the independence check is not order-dependent.
    await setUserEMode.invoke({ categoryId: 0 });

    const wc2 = createWalletClient({
      transport: http(`http://127.0.0.1:${anvil.port}`),
      account: acct2Addr, // Anvil unlocked account
    });
    const provider2 = createAaveV3MantleProvider({
      walletClient: wc2,
      publicClient,
      chain,
      addresses: { pool: mocks.pool, oracle: mocks.oracle, sUsde: mocks.sUsde },
    });

    await provider2.actions.setUserEMode.invoke({ categoryId: 1 });

    const eMode2 = await getUserEMode(publicClient, mocks.pool, acct2Addr);
    expect(eMode2).toBe(1);

    // TEST_ACCOUNT is still at 0 — acct2's eMode change did not affect it.
    const eMode1 = await getUserEMode(publicClient, mocks.pool, TEST_ACCOUNT);
    expect(eMode1).toBe(0);
  });
});
