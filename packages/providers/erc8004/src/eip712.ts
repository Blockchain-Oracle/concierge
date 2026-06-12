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

// Recursively serialize with sorted object keys for deterministic hashing.
// BigInt → quoted decimal string (JSON.stringify throws on BigInt).
// Arrays recurse element-by-element so nested key order is also normalized.
// Throws on non-serializable values (undefined, functions, built-in objects)
// so callers don't silently ship a corrupted hash commitment.
function sortedJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(
      `[@concierge/erc8004] hashActionPayload: non-serializable value (${typeof value}) in payload`,
    );
  }
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJsonStringify).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(
      `[@concierge/erc8004] hashActionPayload: non-plain-object ${Object.prototype.toString.call(value)} in payload`,
    );
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
