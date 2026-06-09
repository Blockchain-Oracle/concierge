// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Placeholder source so the contracts CI gates (Slither static
/// analysis + forge coverage) have something REAL to analyze. Story-10
/// (ConciergeRegistry base) replaces this with real source.
///
/// DO NOT delete this file before adding real `src/*.sol`. The post-merge
/// review of PR #7 documented a cascade of vacuous-green silent failures
/// (Slither analyzing 0 files exits green, forge coverage on empty src/
/// emits a `| Total | 0/0 |` row that the `\bTotal\b` grep silently
/// passes, etc). Keeping at least ONE file in src/ closes those bypasses
/// at the source — no conditional skips, no `if:` gates, no
/// branch-protection blind spots. Story-10 removes this file as part of
/// the same PR that lands the first real contract.
contract Placeholder {
    uint256 private constant SENTINEL = 1;

    function sentinel() external pure returns (uint256) {
        return SENTINEL;
    }
}
