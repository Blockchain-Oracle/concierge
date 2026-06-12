import { hashTypedData, keccak256, toBytes } from 'viem';

// EIP-712 domain for Concierge action attestations.
// chainId is included so hashes are chain-specific; verifyingContract is omitted
// because the ReputationRegistry address differs across networks and would make
// the hash unstable in environments that don't know the contract address upfront.
const EIP712_DOMAIN = {
  name: 'Concierge',
  version: '1',
} as const;

const ACTION_ATTESTATION_TYPES = {
  ActionAttestation: [
    { name: 'schema', type: 'string' },
    { name: 'agentId', type: 'uint256' },
    { name: 'payloadHash', type: 'bytes32' },
  ],
} as const;

/**
 * Recursively sort object keys alphabetically for deterministic JSON serialization.
 * Plain JSON.stringify does not sort keys, making the hash order-dependent.
 */
function sortedJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => {
      const v = (value as Record<string, unknown>)[k];
      return `${JSON.stringify(k)}:${sortedJsonStringify(v)}`;
    });
  return `{${sorted.join(',')}}`;
}

/**
 * Computes the EIP-712 feedbackHash for a given action payload.
 *
 * The hash is fully deterministic: same payload + agentId + chainId always
 * produces the same bytes32. Object key order in `payload` does NOT affect
 * the result (deep-sorted before hashing).
 */
export function hashActionPayload(
  payload: Record<string, unknown> & { schema: string },
  agentId: bigint,
  chainId: 5000 | 5003,
): `0x${string}` {
  const payloadHash = keccak256(toBytes(sortedJsonStringify(payload)));
  return hashTypedData({
    domain: { ...EIP712_DOMAIN, chainId },
    types: ACTION_ATTESTATION_TYPES,
    primaryType: 'ActionAttestation',
    message: { schema: payload.schema, agentId, payloadHash },
  });
}
