#!/usr/bin/env bash
# postdeploy-verify-mainnet.sh — Story-190. Run AFTER a successful deploy.
# Round-1 fixes silent-failure CRITICAL: awk first-hex grabbed sibling
# addresses + nextAgentId silent-swallow.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly ADDRESSES_FILE="$REPO_ROOT/packages/shared/src/addresses.ts"
readonly EXPECTED_CHAIN_ID=5000
readonly ZERO_ADDR='0x0000000000000000000000000000000000000000'
readonly IDENTITY_REGISTRY='0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'  # ERC-8004 canonical

fatal() { printf '[postdeploy] FATAL: %s\n' "$*" >&2; exit 1; }
ok()    { printf '[postdeploy] ✓ %s\n' "$*" >&2; }

# Required tools + env
for TOOL in cast grep awk; do
  command -v "$TOOL" >/dev/null 2>&1 || fatal "'$TOOL' not found in PATH"
done
[[ -n "${MANTLE_RPC_URL:-}" ]] || fatal "MANTLE_RPC_URL is not set"
[[ -f "$ADDRESSES_FILE" ]] || fatal "addresses file not found: $ADDRESSES_FILE"

# Sanity check: RPC is the right chain.
chain_id_raw=$(cast chain-id --rpc-url "$MANTLE_RPC_URL")
chain_id=$((chain_id_raw))
[[ "$chain_id" -eq "$EXPECTED_CHAIN_ID" ]] || fatal "RPC chain id $chain_id ≠ Mantle Mainnet ($EXPECTED_CHAIN_ID)"
ok "RPC on chain $EXPECTED_CHAIN_ID"

# Round-1 silent-failure CRITICAL: anchor the address extraction to the
# `conciergeRegistry:` key on the SAME LINE — a sibling key (deployer: 0x...)
# or a comment containing 0x... must NOT match. Also assert exactly one
# match — if multiple lines look like `conciergeRegistry: 0x...` something
# is wrong.
matched_lines=$(awk '
  /mantleMainnet:/ { in_mainnet = 1 }
  /mantleSepolia:/ { in_mainnet = 0 }
  in_mainnet && /conciergeRegistry: *.*0x[0-9a-fA-F]{40}/ {
    if (match($0, /0x[0-9a-fA-F]{40}/)) {
      print substr($0, RSTART, RLENGTH)
    }
  }
' "$ADDRESSES_FILE")
match_count=$(printf '%s\n' "$matched_lines" | grep -c '^0x' || true)
[[ "$match_count" -eq 1 ]] || fatal "expected exactly 1 conciergeRegistry address in mantleMainnet block, got $match_count"
registry_addr="$matched_lines"
[[ "$registry_addr" != "$ZERO_ADDR" ]] || fatal "conciergeRegistry is still the ZERO_ADDRESS placeholder — addresses publication step skipped?"
ok "ConciergeRegistry proxy: $registry_addr (unique match)"

# Verify the proxy responds to UUPS proxiableUUID() — canonical ERC-1967 slot.
expected_uuid='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
got_uuid=$(cast call "$registry_addr" 'proxiableUUID()(bytes32)' --rpc-url "$MANTLE_RPC_URL")
[[ "$got_uuid" == "$expected_uuid" ]] || fatal "ConciergeRegistry.proxiableUUID() returned $got_uuid, expected $expected_uuid (ERC-1967 slot)"
ok "proxiableUUID() matches ERC-1967 slot"

# Round-1 silent-failure SUGGESTION: nextAgentId() failure now FATAL — a
# missing selector means the deploy shipped the wrong contract.
next_agent_id=$(cast call "$registry_addr" 'nextAgentId()(uint256)' --rpc-url "$MANTLE_RPC_URL")
[[ -n "$next_agent_id" ]] || fatal "nextAgentId() call returned empty — selector missing, wrong contract deployed?"
ok "nextAgentId() = $next_agent_id"

# Round-1 SUGGESTION (clarity): compare against canonical empty-code marker
# rather than length threshold.
identity_code=$(cast code "$IDENTITY_REGISTRY" --rpc-url "$MANTLE_RPC_URL")
[[ "$identity_code" != "0x" ]] || fatal "ERC-8004 IdentityRegistry at $IDENTITY_REGISTRY has no code — wrong network?"
ok "ERC-8004 IdentityRegistry has code at canonical address"

# Reminder: Mantlescan source-code verification is operator-step.
printf '[postdeploy] manual step: confirm Mantlescan source verification at:\n' >&2
printf '            https://mantlescan.xyz/address/%s#code\n' "$registry_addr" >&2

ok "all automated post-deploy checks passed"
exit 0
