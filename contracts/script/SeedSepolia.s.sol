// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";

import { MockFaucetToken } from "../src/mocks/base/MockFaucetToken.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Mints demo balances to a seed account after DeployAll on Sepolia.
///
/// Bypasses the faucet rate-limit via the privileged `mint()` function
/// (requires MINTER_ROLE — must be called from the admin key used in DeployAll).
///
/// Required env vars:
///   SEED_ACCOUNT  — address to receive demo balances
///   SUSDE_ADDR    — deployed MockSUSDe address
///   USDC_ADDR     — deployed MockUSDC address
///   USDY_ADDR     — deployed MockUSDY address
///   METH_ADDR     — deployed MockMETH address
///
/// Usage:
///   forge script script/SeedSepolia.s.sol \
///     --rpc-url $MANTLE_SEPOLIA_RPC_URL \
///     --private-key $OPS_PRIVATE_KEY \
///     --broadcast
contract SeedSepolia is Script {
    uint256 constant SEED_USDC = 10_000e6; // 10,000 USDC (6 dec)
    uint256 constant SEED_SUSDE = 1000e18; // 1,000 sUSDe
    uint256 constant SEED_USDY = 100e18; // 100 USDY
    uint256 constant SEED_METH = 1e18; // 1 mETH

    function run() external {
        address seedAccount = vm.envAddress("SEED_ACCOUNT");
        address sUSDe = vm.envAddress("SUSDE_ADDR");
        address USDC = vm.envAddress("USDC_ADDR");
        address USDY = vm.envAddress("USDY_ADDR");
        address mETH = vm.envAddress("METH_ADDR");

        // Pre-flight: verify the broadcaster holds MINTER_ROLE on every token.
        // mint() is privileged; missing the role causes a silent revert inside broadcast.
        address minter = tx.origin;
        bytes32 minterRole = MockFaucetToken(sUSDe).MINTER_ROLE();
        address[4] memory tokens = [sUSDe, USDC, USDY, mETH];
        string[4] memory names = ["sUSDe", "USDC", "USDY", "mETH"];
        for (uint256 i = 0; i < tokens.length; i++) {
            require(
                IAccessControl(tokens[i]).hasRole(minterRole, minter),
                string.concat("SeedSepolia: missing MINTER_ROLE on ", names[i])
            );
        }

        vm.startBroadcast();
        MockFaucetToken(sUSDe).mint(seedAccount, SEED_SUSDE);
        MockFaucetToken(USDC).mint(seedAccount, SEED_USDC);
        MockFaucetToken(USDY).mint(seedAccount, SEED_USDY);
        MockFaucetToken(mETH).mint(seedAccount, SEED_METH);
        vm.stopBroadcast();

        console2.log("Seeded %s", seedAccount);
        console2.log("  sUSDe: %d", SEED_SUSDE);
        console2.log("  USDC:  %d", SEED_USDC);
        console2.log("  USDY:  %d", SEED_USDY);
        console2.log("  mETH:  %d", SEED_METH);
    }
}
