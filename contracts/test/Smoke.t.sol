// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { _Placeholder } from "../src/Placeholder.sol";

/// @notice Toolchain smoke test. Validates that the forge-std remapping
/// resolves, solc 0.8.26 + shanghai EVM compiles, basic cheatcodes
/// (`vm.warp`) execute, and src/Placeholder.sol compiles + tests cover
/// it (so `forge coverage` reports a non-vacuous denominator until
/// story-10 ships real source). Replace with real ConciergeRegistry
/// tests in story-11.
contract SmokeTest is Test {
    function test_forgeStdIsWired() public pure {
        assertTrue(true, "forge-std import + Test base class resolve");
    }

    function test_vmCheatcodesExecute() public {
        vm.warp(1_700_000_000);
        assertEq(block.timestamp, 1_700_000_000, "vm.warp cheatcode executed");
    }

    function test_placeholderSentinel() public {
        _Placeholder p = new _Placeholder();
        assertEq(p.sentinel(), 1, "_Placeholder.sentinel() reads constant");
    }
}
