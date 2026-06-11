// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Thin UUPS proxy wrapper for ConciergeRegistry.
/// Deploy this once per network and never redeploy it — upgrades go through
/// ConciergeRegistry._authorizeUpgrade (gated on DEFAULT_ADMIN_ROLE).
///
/// Usage:
///   bytes memory initData = abi.encodeCall(ConciergeRegistry.initialize, (admin));
///   ConciergeRegistryProxy proxy = new ConciergeRegistryProxy(impl, initData);
contract ConciergeRegistryProxy is ERC1967Proxy {
    constructor(
        address implementation,
        bytes memory _data
    ) ERC1967Proxy(implementation, _data) { }
}
