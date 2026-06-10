// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { IConciergeRegistry } from "./interfaces/IConciergeRegistry.sol";
import {
    NotAgentOwner,
    AgentInactive,
    InvalidValidator,
    InvalidOwner,
    EmptyGoalHash,
    PolicyTooLarge,
    AgentNotFound,
    OwnerIndexCorrupted
} from "./errors/ConciergeErrors.sol";

/// @notice On-chain identity + policy store for Concierge agents (ADR-009).
/// UUPS-upgradeable so post-deploy bugfixes don't invalidate the canonical
/// proxy address stored in the shared addresses module.
///
/// Role model:
///   ADMIN_ROLE          — grant/revoke all other roles, authorise upgrades
///   AGENT_OPERATOR_ROLE — call registerAgent
///   PAUSER_ROLE         — pause / unpause mutations
///
/// Agent state machine:
///   activatedAt == 0              → never registered (default mapping slot)
///   activatedAt > 0, active=false → registered but deactivated by owner
///   activatedAt > 0, active=true  → registered and operational
///
/// Storage invariants:
///   agents[id].activatedAt > 0  ↔  id was ever registered
///   nextAgentId starts at 1; 0 is the sentinel "unregistered" value
///   policyData.length ≤ 4096 at write time
///   owner is never address(0) (enforced at register + transfer)
contract ConciergeRegistry is
    IConciergeRegistry,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    // ─── Constants ─────────────────────────────────────────────────────────

    uint256 public constant MAX_POLICY_SIZE = 4096;

    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant AGENT_OPERATOR_ROLE = keccak256("AGENT_OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ─── Storage ───────────────────────────────────────────────────────────

    uint256 public nextAgentId;

    mapping(uint256 agentId => AgentRecord) private _agents;

    /// owner → set of agentIds. Maintained alongside _agents so agentsByOwner
    /// doesn't require a full scan. Removal on transfer is O(n) in the owner's
    /// agent count — acceptable given per-owner scale (< 100 agents typical).
    mapping(address owner => uint256[]) private _agentsByOwner;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Initializer ───────────────────────────────────────────────────────

    /// @notice One-time initializer called via the proxy's constructor data.
    /// @param admin  Address that receives DEFAULT_ADMIN_ROLE + PAUSER_ROLE.
    ///               Must be non-zero; address(0) would make the proxy ungovernable.
    function initialize(
        address admin
    ) external initializer {
        if (admin == address(0)) revert InvalidOwner(admin);

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        nextAgentId = 1;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ─── Mutations ─────────────────────────────────────────────────────────

    /// @inheritdoc IConciergeRegistry
    function registerAgent(
        address owner,
        address validator,
        bytes32 goalHash,
        bytes calldata policyData
    ) external whenNotPaused nonReentrant onlyRole(AGENT_OPERATOR_ROLE) returns (uint256 agentId) {
        if (owner == address(0)) revert InvalidOwner(owner);
        if (validator == address(0)) revert InvalidValidator(validator);
        if (goalHash == bytes32(0)) revert EmptyGoalHash();
        if (policyData.length > MAX_POLICY_SIZE) revert PolicyTooLarge(policyData.length);

        agentId = nextAgentId++;
        _agents[agentId] = AgentRecord({
            owner: owner,
            sessionKeyValidator: validator,
            goalHash: goalHash,
            policyData: policyData,
            activatedAt: block.timestamp,
            active: true
        });
        _agentsByOwner[owner].push(agentId);

        emit AgentRegistered(agentId, owner, validator, goalHash);
    }

    /// @inheritdoc IConciergeRegistry
    function updateGoal(
        uint256 agentId,
        bytes32 newGoalHash
    ) external whenNotPaused {
        _requireRegistered(agentId);
        _requireOwner(agentId);
        if (!_agents[agentId].active) revert AgentInactive(agentId);
        if (newGoalHash == bytes32(0)) revert EmptyGoalHash();

        _agents[agentId].goalHash = newGoalHash;
        emit GoalUpdated(agentId, newGoalHash);
    }

    /// @inheritdoc IConciergeRegistry
    /// @dev Inactive agents are also blocked — consistent with updateGoal. Deactivate,
    ///      then reactivate after the policy is ready.
    function updatePolicy(
        uint256 agentId,
        bytes calldata newPolicy
    ) external whenNotPaused {
        _requireRegistered(agentId);
        _requireOwner(agentId);
        if (!_agents[agentId].active) revert AgentInactive(agentId);
        if (newPolicy.length > MAX_POLICY_SIZE) revert PolicyTooLarge(newPolicy.length);

        _agents[agentId].policyData = newPolicy;
        emit PolicyUpdated(agentId);
    }

    /// @inheritdoc IConciergeRegistry
    function setActive(
        uint256 agentId,
        bool active
    ) external whenNotPaused {
        _requireRegistered(agentId);
        _requireOwner(agentId);

        _agents[agentId].active = active;
        emit ActiveSet(agentId, active);
    }

    /// @inheritdoc IConciergeRegistry
    function transferAgent(
        uint256 agentId,
        address newOwner
    ) external whenNotPaused {
        if (newOwner == address(0)) revert InvalidOwner(newOwner);
        _requireRegistered(agentId);
        _requireOwner(agentId);

        address prev = _agents[agentId].owner;
        if (newOwner == prev) revert InvalidOwner(newOwner);

        _agents[agentId].owner = newOwner;

        _removeFromOwnerIndex(prev, agentId);
        _agentsByOwner[newOwner].push(agentId);

        emit AgentTransferred(agentId, prev, newOwner);
    }

    /// @inheritdoc IConciergeRegistry
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @inheritdoc IConciergeRegistry
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ─── Reads ─────────────────────────────────────────────────────────────

    /// @inheritdoc IConciergeRegistry
    function getAgent(
        uint256 agentId
    ) external view returns (AgentRecord memory) {
        _requireRegistered(agentId);
        return _agents[agentId];
    }

    /// @inheritdoc IConciergeRegistry
    function agentsByOwner(
        address owner
    ) external view returns (uint256[] memory) {
        return _agentsByOwner[owner];
    }

    // ─── Internal helpers ──────────────────────────────────────────────────

    function _requireRegistered(
        uint256 agentId
    ) internal view {
        if (_agents[agentId].activatedAt == 0) revert AgentNotFound(agentId);
    }

    function _requireOwner(
        uint256 agentId
    ) internal view {
        if (_agents[agentId].owner != msg.sender) revert NotAgentOwner(agentId, msg.sender);
    }

    /// O(n) removal from the owner's agent list. Reverts with OwnerIndexCorrupted
    /// if the ID is absent — this should be unreachable under correct operation.
    function _removeFromOwnerIndex(
        address owner,
        uint256 agentId
    ) internal {
        uint256[] storage ids = _agentsByOwner[owner];
        uint256 len = ids.length;
        for (uint256 i = 0; i < len; ++i) {
            if (ids[i] == agentId) {
                ids[i] = ids[len - 1];
                ids.pop();
                return;
            }
        }
        revert OwnerIndexCorrupted(owner, agentId);
    }

    /// @dev UUPS upgrade gate — only DEFAULT_ADMIN_ROLE may trigger upgrades.
    function _authorizeUpgrade(
        address
    ) internal override onlyRole(DEFAULT_ADMIN_ROLE) { }

    // ─── Storage gap ───────────────────────────────────────────────────────

    // 50 reserved slots for future fields. Slots consumed by this contract:
    //   nextAgentId (1) + _agents mapping root (1) + _agentsByOwner mapping root (1) = 3.
    // 50 - 3 = 47 remaining. OZ v5 parents use ERC-7201 namespaced storage
    // and consume zero sequential slots here.
    uint256[47] private __gap;
}
