import type { Address } from '@concierge/shared';
import { type PublicClient, parseAbi } from 'viem';

const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

const oracleAbi = parseAbi(['function getAssetPrice(address asset) view returns (uint256)']);

export async function getBalanceUSDe(
  publicClient: PublicClient,
  usdeAddress: Address,
  user: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: usdeAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [user],
  });
}

export async function getBalanceSusde(
  publicClient: PublicClient,
  susdeAddress: Address,
  user: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: susdeAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [user],
  });
}

/**
 * Returns sUSDe USD price from Aave oracle (1e8 scaled, e.g. 123_214_617 = $1.232).
 * Authoritative for HF calculations — Mantle sUSDe is a non-rebasing OFT with no
 * on-chain convertToAssets; the oracle is the sole price source on this chain.
 */
export async function getPriceUSD(
  publicClient: PublicClient,
  oracleAddress: Address,
  susdeAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: oracleAddress,
    abi: oracleAbi,
    functionName: 'getAssetPrice',
    args: [susdeAddress],
  });
}
