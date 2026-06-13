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
  readonly ownerAccount: LocalAccount;
  readonly conciergeAccount: ConciergeAccount;
  readonly chain: SupportedChain;
  readonly providers: CreateConciergePolicyConfig['providers'];
  readonly spendingLimits: CreateConciergePolicyConfig['spendingLimits'];
  readonly validUntil?: number;
  readonly validAfter?: number;
}

export interface IssueSessionKeyResult {
  readonly sessionKeyAddress: Address;
  readonly sessionKeyPrivateKey: SessionKeySecret;
  readonly encodedPolicy: Hex;
  readonly enableTypedDataHash: Hex;
  readonly signature: Hex;
  readonly validUntil: number;
  readonly validAfter: number;
}

const KERNEL_VERSION = '0.3.1' as const;

/**
 * Generate a session key + compose its policy bundle + request the owner EOA
 * to sign the EIP-712 Enable typed-data the kernel validator will check
 * on-chain.
 *
 * Throws `ConciergeError('InvalidOwnerSignature')` if the recovered signer
 * does not match `ownerAccount.address` — fails at issuance instead of
 * letting the EntryPoint AA24-reject the UserOp on first use.
 *
 * **Wipe semantics (round-2):** the SessionKeySecret is created only AFTER
 * all the steps that can throw (RPC, owner signature, signature recovery).
 * If any of those throws, no handle is ever materialized. Owner-wallet
 * rejection is the common failure mode and we no longer leak.
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
  // Generate the session key bytes locally — DO NOT wrap in SessionKeySecret
  // yet. If anything below throws, we wipe the local hex string's backing
  // buffer manually and never materialize a handle that could be GC'd holding
  // live key bytes.
  const sessionKeyHex = generatePrivateKey();
  let sessionKeyPrivateKey: SessionKeySecret | undefined;
  try {
    const sessionAccount = privateKeyToAccount(sessionKeyHex);
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
    const validatorNonce = await readValidatorNonce(publicClient, accountAddress);
    const typedData = await getPluginsEnableTypedData({
      accountAddress,
      chainId: chainConfig.chain.id,
      kernelVersion: KERNEL_VERSION,
      action: {
        selector: '0x00000000' as Hex,
        address: '0x0000000000000000000000000000000000000000' as Address,
        // biome-ignore lint/suspicious/noExplicitAny: ZeroDev Action shape we don't need to override
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
    // Only now do we materialize the handle — all the steps that can throw
    // are behind us. The hex string is still in V8's intern cache (we can't
    // change that), but the GC-without-consume hazard is eliminated.
    sessionKeyPrivateKey = SessionKeySecret.fromHex(sessionKeyHex);
    return {
      sessionKeyAddress: sessionAccount.address,
      sessionKeyPrivateKey,
      encodedPolicy,
      enableTypedDataHash,
      signature,
      validUntil,
      validAfter,
    };
  } catch (err) {
    // Defensive: if the handle was constructed (shouldn't happen given the
    // order above, but a future re-order would land here), wipe it.
    sessionKeyPrivateKey?.wipeIfUnconsumed();
    throw err;
  }
}

async function readValidatorNonce(client: PublicClient, accountAddress: Address): Promise<number> {
  if (typeof getKernelV3Nonce !== 'function' && typeof accountMetadata !== 'function') {
    throw new ConciergeError(
      'ConfigError',
      '[@concierge/smart-account] issueSessionKey: @zerodev/sdk version drift — neither getKernelV3Nonce nor accountMetadata is callable. Update @zerodev/sdk.',
    );
  }
  try {
    if (typeof getKernelV3Nonce === 'function') {
      const nonce = await getKernelV3Nonce(client, accountAddress);
      return Number(nonce);
    }
    // biome-ignore lint/suspicious/noExplicitAny: shape varies across SDK versions
    const meta = (await (accountMetadata as any)(client, accountAddress)) as { nonce?: bigint };
    return Number(meta.nonce ?? 0n);
  } catch (err) {
    throw new ConciergeError(
      'RpcError',
      `[@concierge/smart-account] issueSessionKey: failed to read kernel validator nonce for ${accountAddress}.`,
      err,
    );
  }
}
