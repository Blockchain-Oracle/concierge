// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Transfer {
    function transfer(
        address to,
        uint256 amount
    ) external returns (bool);
}

/// @notice Minimal Aave rewards controller mock for integration testing.
/// Admin configures a fixed (reward token, amount) pair; claimAllRewards transfers
/// the reward token to `to` and emits the canonical RewardsClaimed event so both
/// the TypeScript log-parser and post-balance assertions are exercised end-to-end.
contract MockRewardsController {
    // ─── Events ──────────────────────────────────────────────────────────────

    event RewardsClaimed(
        address indexed user,
        address indexed reward,
        address indexed to,
        address caller,
        uint256 amount
    );

    // ─── State ────────────────────────────────────────────────────────────────

    address public immutable admin;
    address public rewardToken;
    uint256 public rewardAmount;

    constructor(
        address admin_
    ) {
        require(admin_ != address(0), "zero admin");
        admin = admin_;
    }

    // ─── Admin config ─────────────────────────────────────────────────────────

    function mockSetReward(
        address token,
        uint256 amount
    ) external {
        require(msg.sender == admin, "not admin");
        require(token != address(0), "zero token");
        rewardToken = token;
        rewardAmount = amount;
    }

    // ─── IRewardsController surface ───────────────────────────────────────────

    /// @dev The assets argument is ignored — this mock always returns the single configured reward.
    function claimAllRewards(
        address[] calldata, /* assets */
        address to
    ) external returns (address[] memory rewardsList, uint256[] memory claimedAmounts) {
        require(rewardToken != address(0), "not configured");
        rewardsList = new address[](1);
        claimedAmounts = new uint256[](1);
        rewardsList[0] = rewardToken;
        claimedAmounts[0] = rewardAmount;
        if (rewardAmount > 0) {
            require(IERC20Transfer(rewardToken).transfer(to, rewardAmount), "transfer failed");
        }
        emit RewardsClaimed(msg.sender, rewardToken, to, msg.sender, rewardAmount);
    }
}
