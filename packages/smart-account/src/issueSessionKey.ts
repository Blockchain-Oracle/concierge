import { ConciergeError } from '@concierge/sdk';
import { toPermissionValidator } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { getPluginsEnableTypedData } from '@zerodev/sdk';
import { accountMetadata, getKernelV3Nonce } from '@zerodev/sdk/accounts';
import { getEntryPoint } from '@zerodev/sdk/constants';
import type { Address, Hex, LocalAccount, PublicClient } from 'viem';
import { createPublicClient, hashTypedData, http, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CHAIN_CONFIGS } from './constants.ts';
import { SessionKeySecret } from './crypto/sessionKeySecret.ts';
import { type CreateConciergePolicyConfig, createConciergePolicy } from './policies/index.ts';
import type { ConciergeAccount, SupportedChain } from './types.ts';

export interface IssueSessionKeyConfig {
  /** Owner EOA — signs the EIP-712 Enable typed-data. */
  readonly ownerAccount: LocalAccount;
  /** The deployed concierge account the session key will operate within. */
  readonly conciergeAccount: ConciergeAccount;
  readonly chain: SupportedChain;
  readonly providers: CreateConciergePolicyConfig['providers'];
  readonly spendingLimits: CreateConciergePolicyConfig['spendingLimits'];
  readonly validUntil?: number;
  readonly validAfter?: number;
}

/**
 * The result of a successful issuance. **`sessionKeyPrivateKey` is a
 * single-use redacting handle** (`SessionKeySecret`) — pass it to
 * `persistSessionKey` exactly once. The handle's `consume()` zeroes the
 * underlying buffer; its `toString`/`toJSON` redact so accidental log capture
 * cannot leak the bytes. The class-private field is unreachable even via
 * `as any` casts.
 */
export interface IssueSessionKeyResult {
  readonly sessionKeyAddress: Address;
  readonly sessionKeyPrivateKey: SessionKeySecret;
  /** Raw policy enable bytes — what the on-chain enable consumes. */
  readonly encodedPolicy: Hex;
  /** Hash of the EIP-712 typed-data the owner signed (for audit / debugging). */
  readonly enableTypedDataHash: Hex;
  /** 65-byte EIP-712 signature over the Enable typed-data. */
  readonly signature: Hex;
  readonly validUntil: number;
  readonly validAfter: number;
}

const KERNEL_VERSION = '0.3.1' as const;

/**
 * Generate a session key + compose its policy bundle + request the owner EOA
 * to sign the EIP-712 Enable typed-data the kernel validator will check
 * on-chain. PURE off-chain.
 *
 * Throws `ConciergeError('InvalidOwnerSignature')` if the recovered signer
 * does not match `ownerAccount.address` — fails at issuance instead of
 * letting the EntryPoint AA24-reject the UserOp on first use.
 *
 * Signature scheme: EIP-712 typed-data over the Kernel v3.1 `Enable` struct
 * via ZeroDev's `getPluginsEnableTypedData` (NOT EIP-191 personal-sign over a
 * hash — that scheme would AA24-reject on-chain).
 */
export async function issueSessionKey(
  config: IssueSessionKeyConfig,
): Promise<IssueSessionKeyResult> {
  const chainConfig = CHAIN_CONFIGS[config.chain];
  if (!chainConfig) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] issueSessionKey: UnsupportedChain('${config.chain}') — supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`,
    );
  }
  // Enforce validity-window ordering at issuance — type-design SUGGESTION.
  const now = Math.floor(Date.now() / 1000);
  const validAfter = config.validAfter ?? now;
  const validUntil = config.validUntil ?? now + 7 * 24 * 60 * 60;
  if (validUntil <= validAfter) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] issueSessionKey: validUntil (${validUntil}) must be > validAfter (${validAfter}).`,
    );
  }
  if (validUntil <= now) {
    throw new ConciergeError(
      'ConfigError',
      `[@concierge/smart-account] issueSessionKey: validUntil (${validUntil}) is already in the past (now=${now}).`,
    );
  }
  const sessionKeyHex = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionKeyHex);
  // Wrap immediately in the redacting handle so the raw hex string is never
  // surfaced after this function returns.
  const sessionKeyPrivateKey = new SessionKeySecret(sessionKeyHex);
  const policies = createConciergePolicy({
    providers: config.providers,
    spendingLimits: config.spendingLimits,
    validUntil,
    validAfter,
  });
  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: http(chainConfig.chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint('0.7');
  const signer = await toECDSASigner({ signer: sessionAccount });
  const permissionPlugin = await toPermissionValidator(publicClient, {
    signer,
    // biome-ignore lint/suspicious/noExplicitAny: ZeroDev Policy union; structurally compatible
    policies: policies as any,
    entryPoint,
    kernelVersion: KERNEL_VERSION,
  });
  const encodedPolicy = await permissionPlugin.getEnableData();
  const accountAddress = config.conciergeAccount.smartAccountAddress;
  // Read on-chain validator nonce for the Enable typed-data.
  const validatorNonce = await readValidatorNonce(publicClient, accountAddress);
  const typedData = await getPluginsEnableTypedData({
    accountAddress,
    chainId: chainConfig.chain.id,
    kernelVersion: KERNEL_VERSION,
    // biome-ignore lint/suspicious/noExplicitAny: ZeroDev Action + Hook minimal shape we don't need to override
    action: {
      selector: '0x00000000' as Hex,
      address: '0x0000000000000000000000000000000000000000' as Address,
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: validator plugin we just built
    validator: permissionPlugin as any,
    validatorNonce,
  });
  const enableTypedDataHash = hashTypedData(typedData);
  const signature = await config.ownerAccount.signTypedData(typedData);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (recovered.toLowerCase() !== config.ownerAccount.address.toLowerCase()) {
    throw new ConciergeError(
      'InvalidOwnerSignature',
      `[@concierge/smart-account] issueSessionKey: EIP-712 signature recovery mismatch — recovered '${recovered}' but expected '${config.ownerAccount.address}'. Owner signTypedData callback may be broken or returning garbage.`,
    );
  }
  return {
    sessionKeyAddress: sessionAccount.address,
    sessionKeyPrivateKey,
    encodedPolicy,
    enableTypedDataHash,
    signature,
    validUntil,
    validAfter,
  };
}

/**
 * Read the kernel's validator nonce for the EIP-712 Enable struct. ZeroDev's
 * `getKernelV3Nonce` requires the kernel account address + a public client.
 * Wrapped here so a missing implementation surfaces a typed error rather than
 * an opaque downstream throw.
 */
async function readValidatorNonce(client: PublicClient, accountAddress: Address): Promise<number> {
  try {
    // accountMetadata returns { nonce, name, version, ... }; getKernelV3Nonce
    // returns just the nonce for newer SDK versions. We try both for resilience.
    if (typeof getKernelV3Nonce === 'function') {
      const nonce = await getKernelV3Nonce(client, accountAddress);
      return Number(nonce);
    }
    if (typeof accountMetadata === 'function') {
      // biome-ignore lint/suspicious/noExplicitAny: shape varies across SDK versions
      const meta = (await (accountMetadata as any)(client, accountAddress)) as { nonce?: bigint };
      return Number(meta.nonce ?? 0n);
    }
    return 0;
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] issueSessionKey: failed to read kernel validator nonce for ${accountAddress}.`,
      err,
    );
  }
}
