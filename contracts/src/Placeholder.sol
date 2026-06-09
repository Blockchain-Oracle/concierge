// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Internal placeholder. Keeps src/ non-empty so Slither + forge
/// coverage have analyzable source. Story-10 (ConciergeRegistry) deletes
/// this file. Leading-underscore name discourages external import — if a
/// downstream package picks up `_Placeholder` we know it's accidental.
contract _Placeholder {
    uint256 private constant SENTINEL = 1;

    function sentinel() external pure returns (uint256) {
        return SENTINEL;
    }
}
