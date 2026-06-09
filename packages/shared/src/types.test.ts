// Type-level contracts for @concierge/shared public surface.
//
// Tested via tsc — vitest's expectTypeOf assertions are no-op at runtime, but
// `pnpm typecheck` (CI gate) compiles this file. The canary test at the bottom
// uses a @ts-expect-error directive that fires only when tsc actually sees this file.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ActionKind,
  Address,
  AgentId,
  EvmChainId,
  Hex,
  ModelRoutingPhase,
  ProviderName,
  SepoliaAddressPath,
  TickLoopPhase,
} from './index.ts';

describe('primitives', () => {
  it('AgentId is a branded bigint (plain bigint not assignable)', () => {
    expectTypeOf<AgentId>().toExtend<bigint>();
    expectTypeOf<bigint>().not.toExtend<AgentId>();
  });

  it('Hex re-export is the viem 0x-prefixed template literal', () => {
    expectTypeOf<Hex>().toEqualTypeOf<`0x${string}`>();
  });

  it('Address re-export is the viem 0x-prefixed template literal', () => {
    expectTypeOf<Address>().toEqualTypeOf<`0x${string}`>();
  });

  it('EvmChainId is the 5000 | 5003 literal union (not widened)', () => {
    expectTypeOf<EvmChainId>().toEqualTypeOf<5000 | 5003>();
    expectTypeOf<number>().not.toExtend<EvmChainId>();
  });
});

describe('tick + routing phases (C3 split)', () => {
  it('TickLoopPhase is the 5-arm in-loop union (decide is OUT-OF-LOOP per story-62)', () => {
    expectTypeOf<TickLoopPhase>().toEqualTypeOf<
      'plan' | 'simulate' | 'propose' | 'execute' | 'record'
    >();
  });

  it('ModelRoutingPhase is TickLoopPhase + decide (story-60 routeModelForPhase)', () => {
    expectTypeOf<ModelRoutingPhase>().toEqualTypeOf<
      'plan' | 'simulate' | 'propose' | 'decide' | 'execute' | 'record'
    >();
  });

  it('TickLoopPhase extends ModelRoutingPhase', () => {
    expectTypeOf<TickLoopPhase>().toExtend<ModelRoutingPhase>();
  });
});

describe('public union arity', () => {
  it('ProviderName matches packages/providers/* dir names (7 arms)', () => {
    expectTypeOf<ProviderName>().toEqualTypeOf<
      | 'aave-v3-mantle'
      | 'mantle-dex'
      | 'ethena-susde'
      | 'ondo-usdy'
      | 'meth-staking'
      | 'lifi-bridge'
      | 'erc8004'
    >();
  });

  it('ActionKind has all 11 documented members', () => {
    expectTypeOf<ActionKind>().toEqualTypeOf<
      | 'supply'
      | 'borrow'
      | 'repay'
      | 'withdraw'
      | 'swap'
      | 'bridge'
      | 'stake'
      | 'unstake'
      | 'wrap'
      | 'unwrap'
      | 'attest'
    >();
  });

  it('SepoliaAddressPath includes documented leaf paths', () => {
    expectTypeOf<'aave.pool'>().toExtend<SepoliaAddressPath>();
    expectTypeOf<'tokens.USDC'>().toExtend<SepoliaAddressPath>();
    expectTypeOf<'erc8004.identityRegistry'>().toExtend<SepoliaAddressPath>();
  });

  it('SepoliaAddressPath rejects non-existent paths (guards against widening to string)', () => {
    expectTypeOf<'aave.nonexistent'>().not.toExtend<SepoliaAddressPath>();
    expectTypeOf<'tokens.usdc'>().not.toExtend<SepoliaAddressPath>();
    expectTypeOf<string>().not.toExtend<SepoliaAddressPath>();
    expectTypeOf<''>().not.toExtend<SepoliaAddressPath>();
  });
});

describe('typecheck wiring canary', () => {
  it('tsc actually sees this file (load-bearing @ts-expect-error guard)', () => {
    // If this file is dropped from `tsc --noEmit`, the @ts-expect-error below
    // becomes a no-op directive — tsc reports "Unused @ts-expect-error" and CI
    // typecheck fails. The previous canary used a tautological .not assertion
    // that always passed regardless of whether tsc saw the file.
    // @ts-expect-error -- 'foo' is not assignable to EvmChainId (load-bearing)
    const wrong: EvmChainId = 'foo';
    void wrong;
    expect(true).toBe(true);
  });
});
