import { ConciergeError } from '@concierge/sdk';
import { toPermissionValidator } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { getEntryPoint } from '@zerodev/sdk/constants';
import type { Address, Hex, LocalAccount } from 'viem';
import { createPublicClient, http, keccak256, recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CHAIN_CONFIGS } from './constants.ts';
import { type CreateConciergePolicyConfig, createConciergePolicy } from './policies/index.ts';
import type { SupportedChain } from './types.ts';

export interface IssueSessionKeyConfig {
  /** Owner EOA — signs the policy approval. */
  readonly ownerAccount: LocalAccount;
  /** Mantle chain the session key will operate on. */
  readonly chain: SupportedChain;
  /** Policy composition inputs (passed through to createConciergePolicy). */
  readonly providers: CreateConciergePolicyConfig['providers'];
  readonly spendingLimits: CreateConciergePolicyConfig['spendingLimits'];
  /** Optional validity window — defaults to 7 days via createTimeFramePolicy. */
  readonly validUntil?: number;
  readonly validAfter?: number;
}

/**
 * The result of a successful issuance. **`sessionKeyPrivateKey` is the ONLY
 * surface the plaintext key ever appears on** — callers MUST hand it to
 * `persistSessionKey` (or wipe it manually) and drop the reference. The 32-byte
 * hex string is immutable in JS; the wipe pattern in persistSessionKey works
 * on the Buffer copy used for encryption, not on this string. The trade-off:
 * V8 may retain the string in the literal cache until GC. Threat model assumes
 * the issuance host is trusted; if not, prefer in-browser flows that never
 * persist via this surface.
 */
export interface IssueSessionKeyResult {
  readonly sessionKeyAddress: Address;
  readonly sessionKeyPrivateKey: Hex;
  /** The policy approval bytes the owner signed. */
  readonly encodedPolicy: Hex;
  /** 65-byte owner EOA signature over keccak256(encodedPolicy). */
  readonly signature: Hex;
  readonly validUntil: number;
  readonly validAfter: number;
}

/**
 * Generate a session key + compose its policy bundle + request the owner EOA
 * to sign the policy approval. PURE off-chain: no bundler / no UserOp. The
 * returned values are persisted by `persistSessionKey` and consumed by the
 * worker at tick time.
 *
 * Throws `ConciergeError('InvalidOwnerSignature')` if the recovered signer
 * does not match `ownerAccount.address` — better to fail at issuance than
 * later when the EntryPoint AA24-rejects the UserOp on-chain.
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
  const sessionKeyPrivateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionKeyPrivateKey);
  const policies = createConciergePolicy({
    providers: config.providers,
    spendingLimits: config.spendingLimits,
    ...(config.validUntil !== undefined && { validUntil: config.validUntil }),
    ...(config.validAfter !== undefined && { validAfter: config.validAfter }),
  });
  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: http(chainConfig.chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint('0.7');
  const signer = await toECDSASigner({ signer: sessionAccount });
  const permissionPlugin = await toPermissionValidator(publicClient, {
    signer,
    // biome-ignore lint/suspicious/noExplicitAny: ZeroDev Policy union vs our policy bundle; structurally compatible
    policies: policies as any,
    entryPoint,
    kernelVersion: '0.3.1' as const,
  });
  // getEnableData produces the bytes the owner signs to approve the validator.
  const encodedPolicy = await permissionPlugin.getEnableData();
  const policyHash = keccak256(encodedPolicy);
  const signature = await config.ownerAccount.signMessage({
    message: { raw: policyHash },
  });
  // Verify the signature recovers to the owner — fail at issuance, not on-chain.
  // signMessage applied the EIP-191 personal-sign prefix to policyHash, so we
  // recover via recoverMessageAddress with the same prefixing semantics.
  const recovered = await recoverMessageAddress({
    message: { raw: policyHash },
    signature,
  });
  if (recovered.toLowerCase() !== config.ownerAccount.address.toLowerCase()) {
    throw new ConciergeError(
      'InvalidOwnerSignature',
      `[@concierge/smart-account] issueSessionKey: signature recovery mismatch — recovered '${recovered}' but expected '${config.ownerAccount.address}'. Owner signMessage callback may be broken or returning garbage.`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionKeyAddress: sessionAccount.address,
    sessionKeyPrivateKey,
    encodedPolicy,
    signature,
    validUntil: config.validUntil ?? now + 7 * 24 * 60 * 60,
    validAfter: config.validAfter ?? now,
  };
}
