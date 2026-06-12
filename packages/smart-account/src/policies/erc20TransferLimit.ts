import { ConciergeError } from '@concierge/sdk';
import { ParamCondition } from '@zerodev/permissions/policies';
import type { Address, Hex } from 'viem';
import { isAddress, pad, toHex } from 'viem';
import type { CallPermission } from './callPolicy.ts';

/**
 * Per-tx cap on the ERC-20 `transfer(to, amount)` amount parameter.
 *
 * **Scope:** This policy enforces ONLY the ERC-20 `transfer(address,uint256)` selector.
 * It does NOT cover `transferFrom`, `approve`, EIP-2612 `permit`, fee-on-transfer
 * routers, or any meta-tx path. A session key could still drain funds via:
 *   - `approve(spender, max)` followed by an off-chain `transferFrom`
 *   - non-standard token interfaces (USDT-style approve race, fee-on-transfer)
 * The composer (`createConciergePolicy`) merges the rule into a SINGLE merged
 * call policy so it actually constrains the session key — sibling policies are
 * AND'd by ZeroDev's permission validator and do not modify each other.
 *
 * **Spec drift (audit §19):** Story-52 originally specified
 * `createSpendingLimitPolicy({ dailyLimit })` with a 24h rolling window. ZeroDev's
 * primitives do NOT support rolling-value windows — only per-tx caps via CallPolicy
 * rules, or per-interval *count* caps via RateLimitPolicy. "Daily" semantics live
 * off-chain at session-key issuance: tomorrow's issuance mints a fresh session key
 * with a new per-tx allowance.
 */
export interface Erc20TransferLimitConfig {
  /** ERC-20 token contract the cap applies to. Must be a valid 20-byte address. */
  readonly token: Address;
  /** Maximum amount (in token smallest unit) any single transfer may carry. Must satisfy 0 < x <= 2^256 - 1. */
  readonly maxAmountPerTx: bigint;
}

/** keccak256("transfer(address,uint256)")[:4] */
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb' as Hex;
/** ERC-20 transfer(to, amount) calldata layout (after the 4-byte selector): to @ 0, amount @ 32. */
const TRANSFER_AMOUNT_OFFSET = 32;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Build a CallPermission carrying a LESS_THAN_OR_EQUAL rule on transfer(amount).
 * Returns a permission fragment (NOT a Policy) so it can be merged into the
 * single call policy by the composer — sibling policies cannot enforce this
 * constraint because ZeroDev's validator AND's policies.
 */
export function createErc20TransferLimit(config: Erc20TransferLimitConfig): CallPermission {
  if (!isAddress(config.token)) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createErc20TransferLimit: InvalidPolicy: token is not a valid address: '${config.token}'`,
    );
  }
  if (config.token.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] createErc20TransferLimit: InvalidPolicy: token is the zero address — limit would silently never match a real ERC-20 transfer.',
    );
  }
  if (config.maxAmountPerTx <= 0n) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createErc20TransferLimit: InvalidPolicy: maxAmountPerTx must be > 0, got ${config.maxAmountPerTx}`,
    );
  }
  if (config.maxAmountPerTx > UINT256_MAX) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] createErc20TransferLimit: InvalidPolicy: maxAmountPerTx (${config.maxAmountPerTx}) exceeds uint256 max.`,
    );
  }
  return {
    target: config.token,
    selector: ERC20_TRANSFER_SELECTOR,
    rules: [
      {
        condition: ParamCondition.LESS_THAN_OR_EQUAL,
        offset: TRANSFER_AMOUNT_OFFSET,
        params: [pad(toHex(config.maxAmountPerTx), { size: 32 })],
      },
    ],
  };
}
