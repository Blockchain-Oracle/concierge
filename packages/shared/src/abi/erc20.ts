// Minimal ERC-20 ABI for Concierge tools (Aave supply/withdraw, sUSDe stake, DEX swaps).

import { type Abi, parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]) satisfies Abi;
