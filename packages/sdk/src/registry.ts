import {
  ADDRESSES,
  type Address,
  type AddressPath,
  type EvmChainId,
  ZERO_ADDRESS,
} from '@concierge/shared';
import type { ConciergeAgentLike } from '@concierge/tools';
import { ConciergeError } from './errors.ts';

type MainnetAddresses = typeof ADDRESSES.mantleMainnet;
type SepoliaAddresses = typeof ADDRESSES.mantleSepolia;

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Bundled Mantle address registry per story-22 / ADR-019's quickstart:
 * `createConcierge({ registry: ConciergeRegistry.mainnet() })`. The
 * `addresses` field is the SAME frozen object `@concierge/shared` exports —
 * by reference, never a copy — so there is exactly one source of truth and
 * mutation is impossible (shared deep-freezes it; instances freeze too).
 *
 * Implements `ConciergeAgentLike`, so a registry can be handed directly to
 * `createConciergeTools` / any adapter factory as the agent context.
 *
 * Sepolia note: non-ERC-8004 Sepolia addresses are zero placeholders until
 * story-192's mock deploy lands — see `@concierge/shared/addresses.ts` and
 * `SEPOLIA_PENDING_ADDRESS_SLOTS`. Use `requireAddress` instead of reading
 * `addresses` directly when an address is about to be CALLED or FUNDED.
 */
export class ConciergeRegistry implements ConciergeAgentLike {
  private constructor(
    public readonly chainId: EvmChainId,
    public readonly addresses: MainnetAddresses | SepoliaAddresses,
  ) {
    Object.freeze(this);
  }

  static mainnet(): ConciergeRegistry {
    return new ConciergeRegistry(5000, ADDRESSES.mantleMainnet);
  }

  static sepolia(): ConciergeRegistry {
    return new ConciergeRegistry(5003, ADDRESSES.mantleSepolia);
  }

  /**
   * Resolves a dot-path to a DEPLOYED address, throwing
   * `ConciergeError('NetworkUnsupported')` for zero-address placeholder
   * slots. Without this, a provider on Mantle Sepolia would `eth_call`
   * `0x000…000` and get an opaque ABI-decode failure — or burn native value
   * sent to the zero address outright.
   *
   * The two failure modes are deliberately distinct: a path that does not
   * resolve to an address-shaped leaf is caller misuse (plain-JS typo, the
   * compile-time `AddressPath` union can't protect them) and throws
   * `TypeError`; only a real slot holding the zero placeholder throws the
   * typed `NetworkUnsupported`, so `switch (err.type)` handlers never chase
   * a network problem that is actually a typo.
   */
  requireAddress(path: AddressPath): Address {
    // Optional chaining propagates `undefined` for any missing segment, so
    // null/undefined mid-path → undefined leaf → ADDRESS_SHAPE check throws.
    // Prototype-pollution paths like `__proto__.x` resolve via the prototype
    // chain but yield non-Address values — also caught by the shape check.
    // This safe traversal relies on `this.addresses` being deeply frozen
    // (mutation would let an attacker plant an address-shaped leaf mid-path).
    const leaf = path
      .split('.')
      .reduce<unknown>(
        (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
        this.addresses,
      );
    // Shape check, not just typeof: strings are indexable, so a stray
    // trailing segment ('tokens.USDC.0') yields '0x0…0'[0] === '0' — a
    // string that is NOT the zero address and would otherwise leak through.
    if (typeof leaf !== 'string' || !ADDRESS_SHAPE.test(leaf)) {
      throw new TypeError(
        `[@concierge/sdk] requireAddress: "${path}" is not a leaf address slot on chain ${this.chainId} — expected a dot-path like "aave.pool" (see AddressPath in @concierge/shared).`,
      );
    }
    if (leaf === ZERO_ADDRESS) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/sdk] address slot "${path}" is not deployed on chain ${this.chainId} — it is a pending zero-address placeholder (see SEPOLIA_PENDING_ADDRESS_SLOTS). Use ConciergeRegistry.mainnet() or wait for the Sepolia mock deploys.`,
      );
    }
    return leaf as Address;
  }
}
