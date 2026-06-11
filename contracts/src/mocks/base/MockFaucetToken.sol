// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Errors
error FaucetCooldownActive(uint256 remainingSeconds);
error FaucetAmountExceedsCap(uint256 requested, uint256 cap);
error FaucetZeroAmount();
error FaucetZeroAdmin();
error FaucetZeroCap();

/// @notice Abstract base for Sepolia mock ERC-20 tokens with a rate-limited public faucet.
/// Subclasses set the per-call cap and token metadata via the constructor.
/// @dev Admin (MINTER_ROLE) can mint without cap/cooldown restrictions — used by SeedSepolia.s.sol.
abstract contract MockFaucetToken is ERC20, AccessControl {
    // ─── Roles ───────────────────────────────────────────────────────────────

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    // ─── Events ──────────────────────────────────────────────────────────────

    event FaucetClaim(address indexed recipient, uint256 amount);

    // ─── Constants ───────────────────────────────────────────────────────────

    uint256 public constant FAUCET_COOLDOWN = 1 days;

    // ─── State ───────────────────────────────────────────────────────────────

    uint256 internal immutable _faucetCap;
    // Cooldown keyed on the CALLER (msg.sender), not the recipient — prevents griefing.
    mapping(address caller => uint256 timestamp) public lastFaucetAt;

    constructor(
        string memory name_,
        string memory symbol_,
        address admin,
        uint256 faucetCap_
    ) ERC20(name_, symbol_) {
        if (admin == address(0)) revert FaucetZeroAdmin();
        if (faucetCap_ == 0) revert FaucetZeroCap();
        _faucetCap = faucetCap_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    // ─── Public accessors ────────────────────────────────────────────────────

    function faucetCap() external view returns (uint256) {
        return _faucetCap;
    }

    // ─── Faucet ───────────────────────────────────────────────────────────────

    function faucet(
        address to,
        uint256 amount
    ) external {
        if (amount == 0) revert FaucetZeroAmount();
        if (amount > _faucetCap) revert FaucetAmountExceedsCap(amount, _faucetCap);
        uint256 last = lastFaucetAt[msg.sender];
        // forge-lint: disable-next-line(block-timestamp)
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            // forge-lint: disable-next-line(block-timestamp)
            revert FaucetCooldownActive(last + FAUCET_COOLDOWN - block.timestamp);
        }
        // forge-lint: disable-next-line(block-timestamp)
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(to, amount);
        emit FaucetClaim(to, amount);
    }

    // ─── Admin mint ───────────────────────────────────────────────────────────

    function mint(
        address to,
        uint256 amount
    ) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
