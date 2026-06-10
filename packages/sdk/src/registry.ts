import {
  ADDRESSES,
  type Address,
  type EvmChainId,
  type SepoliaAddressPath,
} from '@concierge/shared';
import type { ConciergeAgentLike } from '@concierge/tools';
import { ConciergeError } from './errors.ts';

type MainnetAddresses = typeof ADDRESSES.mantleMainnet;
type SepoliaAddresses = typeof ADDRESSES.mantleSepolia;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
   * sent to the zero address outright. (`SepoliaAddressPath` is the path
   * type for BOTH chains; the two address shapes are structurally identical.)
   */
  requireAddress(path: SepoliaAddressPath): Address {
    const leaf = path
      .split('.')
      .reduce<unknown>(
        (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
        this.addresses,
      );
    if (typeof leaf !== 'string' || leaf === ZERO_ADDRESS) {
      throw new ConciergeError(
        'NetworkUnsupported',
        `[@concierge/sdk] address slot "${path}" is not deployed on chain ${this.chainId} — it is a pending zero-address placeholder (see SEPOLIA_PENDING_ADDRESS_SLOTS). Use ConciergeRegistry.mainnet() or wait for the Sepolia mock deploys.`,
      );
    }
    return leaf as Address;
  }
}
