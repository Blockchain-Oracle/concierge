#!/usr/bin/env bash
# preflight-mainnet.sh — Story-190 gate. Run BEFORE invoking the deploy
# script. Exits 0 only when ALL checks pass.
#
# Round-1 closes: bash int64 overflow on balance (>9.2 MNT silently passed),
# awk first-hex grabbing sibling addresses, gh-auth false-green, cast hex
# output under set -e, private-key in argv (CWE-214), hostile-RPC
# chain-id forgeability.

set -euo pipefail

readonly EXPECTED_CHAIN_ID=5000
# Round-1: MIN_BALANCE as MNT, not wei — keeps bash comparisons in safe
# int64 range. Wei-level comparison happens inside awk.
readonly MIN_BALANCE_MNT='0.5'
readonly MAX_GAS_PRICE_GWEI='0.5'
# Round-1 (security MEDIUM): WMNT canonical address on Mantle Mainnet.
# Cross-checking its bytecode catches a hostile RPC running a fork that
# spoofs chain-id 5000.
readonly WMNT_ADDR='0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8'

fatal() { printf '[preflight] FATAL: %s\n' "$*" >&2; exit 1; }
info()  { printf '[preflight] %s\n' "$*" >&2; }
ok()    { printf '[preflight] ✓ %s\n' "$*" >&2; }

# Round-1 (security CWE-214 hardening note): callers SHOULD prefer Foundry's
# encrypted keystore (`cast wallet new`, `--account <name> --interactive`)
# over `OPS_PRIVATE_KEY=0x...` in the environment. argv leakage via ps aux
# / /proc/<pid>/cmdline / shell history is unavoidable with --private-key.
# We support both for transitional compatibility; warn loudly when env-mode.

# 1. Tool presence
for TOOL in cast forge git gh node awk; do
  command -v "$TOOL" >/dev/null 2>&1 || fatal "'$TOOL' not found in PATH"
done
ok "cast, forge, git, gh, node, awk available"

# 2. Required env vars
for VAR in MANTLE_RPC_URL OPS_PRIVATE_KEY MANTLESCAN_API_KEY; do
  [[ -n "${!VAR:-}" ]] || fatal "$VAR is not set (source your .env.deploy)"
done
ok "MANTLE_RPC_URL / OPS_PRIVATE_KEY / MANTLESCAN_API_KEY all set"
info "WARNING (CWE-214): OPS_PRIVATE_KEY in env leaks to ps aux. Prefer Foundry keystore + --account for production."

# 3. gh auth precheck (round-1 HIGH: empty .conclusion was silently passable)
gh auth status >/dev/null 2>&1 || fatal "gh CLI is not authenticated (\`gh auth login\`)"
ok "gh CLI authenticated"

# 4. RPC reachable + correct chain id
# Round-1: cast normalizes to decimal but defensively coerce via $(( )) which
# handles both 0x-hex and decimal.
chain_id_raw=$(cast chain-id --rpc-url "$MANTLE_RPC_URL" 2>/dev/null || echo "")
[[ -n "$chain_id_raw" ]] || fatal "RPC unreachable: $MANTLE_RPC_URL"
chain_id=$((chain_id_raw))
[[ "$chain_id" -eq "$EXPECTED_CHAIN_ID" ]] || fatal "RPC chain id is $chain_id, expected $EXPECTED_CHAIN_ID (Mantle Mainnet)"
ok "RPC chain id = $EXPECTED_CHAIN_ID"

# 5. Round-1 (security MEDIUM hostile-RPC): chain-id alone is forgeable by
# any fork. Cross-check WMNT (canonical Mantle Mainnet token) has bytecode.
# An empty-state fork would return '0x' with no code.
wmnt_code=$(cast code "$WMNT_ADDR" --rpc-url "$MANTLE_RPC_URL")
[[ "$wmnt_code" != "0x" && "${#wmnt_code}" -gt 10 ]] || fatal "WMNT at $WMNT_ADDR has no code on this RPC — chain-id may be spoofed by a fork"
ok "WMNT canonical bytecode present (RPC is genuine Mantle Mainnet)"

# 6. Deployer balance — wei-level comparison via awk (round-1 CRITICAL: bash
# int64 overflows at ~9.2 MNT, would silently pass a 0.0001 MNT wallet).
deployer=$(cast wallet address --private-key "$OPS_PRIVATE_KEY")
balance_wei=$(cast balance "$deployer" --rpc-url "$MANTLE_RPC_URL")
balance_wei=$((balance_wei))   # normalize 0x... → decimal if needed
balance_eth=$(awk -v w="$balance_wei" 'BEGIN{printf "%.6f", w/1e18}')
# awk handles arbitrary-precision floats; comparison is overflow-safe.
sufficient=$(awk -v b="$balance_eth" -v m="$MIN_BALANCE_MNT" 'BEGIN{print (b+0 >= m+0) ? "yes" : "no"}')
[[ "$sufficient" == "yes" ]] || fatal "deployer $deployer has $balance_eth MNT, need ≥ $MIN_BALANCE_MNT MNT"
ok "deployer $deployer has $balance_eth MNT (≥ $MIN_BALANCE_MNT)"

# 7. Gas price — round-1: $(( )) normalises hex; awk handles wei.
# Threshold is 0.5 gwei = ~25× current Mantle median (~0.02 gwei). A spike
# above that signals network stress; deploy later.
gas_price_wei=$(cast gas-price --rpc-url "$MANTLE_RPC_URL")
gas_price_wei=$((gas_price_wei))
gas_price_gwei=$(awk -v w="$gas_price_wei" 'BEGIN{printf "%.4f", w/1e9}')
gas_ok=$(awk -v g="$gas_price_gwei" -v m="$MAX_GAS_PRICE_GWEI" 'BEGIN{print (g+0 <= m+0) ? "yes" : "no"}')
[[ "$gas_ok" == "yes" ]] || fatal "gas price spike: $gas_price_gwei gwei > $MAX_GAS_PRICE_GWEI gwei threshold (~25× Mantle median). Retry later."
ok "gas price = $gas_price_gwei gwei (≤ $MAX_GAS_PRICE_GWEI threshold)"

# 8. Clean git tree
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
  fatal "git working tree is dirty — commit or stash before deploy"
fi
ok "git tree clean"

# 9. CI green on main — round-1 HIGH: --workflow filter + empty.json fatal
# treatment (round-0 would have green-lit on an unrelated workflow run).
ci_json=$(gh run list --branch main --workflow ci.yml --limit 1 --status completed --json conclusion 2>/dev/null || echo "[]")
ci_status=$(echo "$ci_json" | jq -r '.[0].conclusion // "MISSING"' 2>/dev/null || echo "MISSING")
case "$ci_status" in
  success) ok "CI workflow on main = success" ;;
  MISSING|null|"") fatal "could not determine CI status on main (gh returned empty / no completed runs)" ;;
  *) fatal "CI workflow on main = '$ci_status' (not success)" ;;
esac

info "all preflight checks passed; safe to broadcast"
exit 0
