// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Toolchain smoke test. Validates that the forge-std remapping
/// resolves, solc 0.8.26 + shanghai EVM compiles, and basic cheatcodes
/// (`vm.warp`) execute. Replace with real ConciergeRegistry tests in
/// story-11. Keeping this file forces `forge test` to actually iterate
/// at least one test case — without it, `forge test` is a vacuous green.
contract SmokeTest is Test {
    function test_forgeStdIsWired() public pure {
        assertTrue(true, "forge-std import + Test base class resolve");
    }

    function test_vmCheatcodesExecute() public {
        vm.warp(1_700_000_000);
        assertEq(block.timestamp, 1_700_000_000, "vm.warp cheatcode executed");
    }
}
