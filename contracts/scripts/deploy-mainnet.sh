#!/usr/bin/env bash
# deploy-mainnet.sh — Interactive Mantle Mainnet deploy wrapper for DeployAll.s.sol.
#
# Steps:
#   1. Pre-flight: env vars, cast/forge/node/gh present, MNT balance ≥ 0.3, clean git tree, CI green
#   2. Chain-id verification (guard against pointing at Sepolia or another chain)
#   3. Summary printout (irreversibility warning)
#   4. Exact-string confirmation: type DEPLOY-MAINNET (not y/N — fat-finger-safe)
#   5. forge script --broadcast only (secrets via env, not argv — invisible to ps aux)
#   6. forge script --verify --resume (non-fatal — Mantlescan outage must not strand a deploy)
#   7. write-addresses.mjs --network mainnet
#   8. postdeploy-smoke.mjs
#   9. Next-steps reminder
#
# Required env vars: MANTLE_RPC_URL, OPS_PRIVATE_KEY, MANTLESCAN_API_KEY
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"

# --- Tool presence ---

for TOOL in cast forge node gh git; do
  if ! command -v "$TOOL" &>/dev/null; then
    echo "ERROR: '$TOOL' not found in PATH — install it first." >&2
    exit 1
  fi
done

# --- Required env vars ---

for VAR in MANTLE_RPC_URL OPS_PRIVATE_KEY MANTLESCAN_API_KEY; do
  if [[ -z "${!VAR:-}" ]]; then
    echo "ERROR: $VAR is not set. Export it before running this script." >&2
    exit 1
  fi
done

# --- Promote secrets to Foundry-native env vars (never in argv — visible via ps aux) ---
# Foundry reads ETH_PRIVATE_KEY and ETHERSCAN_API_KEY from the environment automatically.
export ETH_PRIVATE_KEY="$OPS_PRIVATE_KEY"
export ETHERSCAN_API_KEY="$MANTLESCAN_API_KEY"

# --- Derive deployer address ---
# cast wallet address reads ETH_PRIVATE_KEY from env; key does not appear in process argv.

DEPLOYER=$(cast wallet address) || {
  echo "ERROR: Cannot derive deployer address — is OPS_PRIVATE_KEY a valid hex private key?" >&2
  exit 1
}
echo "Deployer: $DEPLOYER"

# --- MNT balance check (≥ 0.3 MNT required) ---

BALANCE_WEI=$(cast balance "$DEPLOYER" --rpc-url "$MANTLE_RPC_URL") || {
  echo "ERROR: Cannot fetch balance — check MANTLE_RPC_URL ($MANTLE_RPC_URL)" >&2
  exit 1
}
if ! [[ "$BALANCE_WEI" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Balance response is not a positive integer: '${BALANCE_WEI}' — RPC may be returning an error body." >&2
  exit 1
fi
REQUIRED_WEI=300000000000000000 # 0.3 MNT in wei
if (( BALANCE_WEI < REQUIRED_WEI )); then
  echo "ERROR: Insufficient MNT for deploy (need ≥ 0.3 MNT [${REQUIRED_WEI} wei], have ${BALANCE_WEI} wei)" >&2
  exit 1
fi
echo "Balance OK: ${BALANCE_WEI} wei"

# --- Clean git tree ---

GIT_STATUS=$(git -C "$REPO_ROOT" status --porcelain) || {
  echo "ERROR: git status failed — is REPO_ROOT a git repository? (${REPO_ROOT})" >&2
  exit 1
}
if [[ -n "$GIT_STATUS" ]]; then
  echo "ERROR: Uncommitted changes — commit or stash first" >&2
  exit 1
fi

# --- CI green check (most recent run on main) ---

CI_CONCLUSION=$(gh run list \
  --repo Blockchain-Oracle/concierge \
  --branch main \
  --limit 1 \
  --json conclusion \
  --jq '.[0].conclusion') || {
  echo "WARNING: Cannot fetch CI status — gh may not be authenticated." >&2
  read -rp "CI check failed. Type YES to continue anyway (or anything else to abort): " ci_confirm
  if [[ "$ci_confirm" != "YES" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
  CI_CONCLUSION="unknown-skip"
}

if [[ "$CI_CONCLUSION" != "success" && "$CI_CONCLUSION" != "unknown-skip" ]]; then
  echo "WARNING: Most recent CI run on main is '${CI_CONCLUSION}' — not green." >&2
  read -rp "CI is not green. Type YES to continue anyway (or anything else to abort): " ci_confirm
  if [[ "$ci_confirm" != "YES" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

# --- Chain-id verification (must be 5000 before showing the confirmation gate) ---
# Prevents deploying to Sepolia (5003) or another chain due to a misconfigured RPC URL.

ACTUAL_CHAIN_ID=$(cast chain-id --rpc-url "$MANTLE_RPC_URL") || {
  echo "ERROR: Cannot verify chain-id — check MANTLE_RPC_URL ($MANTLE_RPC_URL)" >&2
  exit 1
}
if [[ "$ACTUAL_CHAIN_ID" != "5000" ]]; then
  echo "ERROR: RPC endpoint returned chain-id ${ACTUAL_CHAIN_ID} — expected 5000 (Mantle Mainnet)." >&2
  echo "       Check MANTLE_RPC_URL is pointing to Mantle Mainnet, not Sepolia (5003) or another chain." >&2
  exit 1
fi
echo "Chain-id OK: 5000 (Mantle Mainnet)"

# --- Summary ---

echo ""
echo "========================================================================"
echo "  CONCIERGE — MANTLE MAINNET DEPLOY (chain 5000)"
echo "========================================================================"
echo "  Deployer  : $DEPLOYER"
echo "  RPC       : $MANTLE_RPC_URL"
echo "  Balance   : $BALANCE_WEI wei"
echo ""
echo "  ⚠  Real \$MNT will be spent on this deploy."
echo "  ⚠  Mainnet contracts CANNOT be undeployed once broadcast."
echo "  ⚠  Verify this is the correct private key and RPC endpoint."
echo "========================================================================"
echo ""

# --- Exact-string confirmation gate ---
# y/N is fat-finger-able; pasting code or scripts might accidentally type 'y'.
# DEPLOY-MAINNET requires deliberate, unambiguous intent.

read -rp "Type DEPLOY-MAINNET to continue (anything else aborts): " confirmation
if [[ "$confirmation" != "DEPLOY-MAINNET" ]]; then
  echo "Aborted — confirmation string did not match 'DEPLOY-MAINNET'." >&2
  exit 1
fi

# --- Step 1: Broadcast ---
# ETH_PRIVATE_KEY and ETHERSCAN_API_KEY are exported above — neither appears in argv.
# --broadcast only: verification is a separate non-fatal step so a Mantlescan hiccup
# does not leave us uncertain about whether the deploy itself succeeded.

echo ""
echo "[1/5] Broadcasting DeployAll.s.sol to Mantle Mainnet..."
cd "$CONTRACTS_DIR"
forge script script/DeployAll.s.sol \
  --rpc-url "$MANTLE_RPC_URL" \
  --broadcast

# --- Step 2: Verify (non-fatal) ---
# --resume replays the already-broadcast artifact — no re-broadcast risk.
# Failure here is a warning, not an abort: contracts are already live and can be
# verified manually on Mantlescan later.

echo ""
echo "[2/5] Submitting source verification to Mantlescan (non-fatal)..."
forge script script/DeployAll.s.sol \
  --rpc-url "$MANTLE_RPC_URL" \
  --verify \
  --verifier-url "https://api.mantlescan.xyz/api" \
  --resume || echo "WARNING: Mantlescan verification failed — verify manually at https://mantlescan.xyz"

# --- Step 3: Write addresses ---

echo ""
echo "[3/5] Writing deployed addresses to packages/shared/src/addresses.ts..."
cd "$REPO_ROOT"
node contracts/scripts/write-addresses.mjs --network mainnet

# --- Step 4: Postdeploy smoke ---

echo ""
echo "[4/5] Running postdeploy smoke check..."
MANTLE_RPC_URL="$MANTLE_RPC_URL" node contracts/scripts/postdeploy-smoke.mjs

# --- Step 5: Next steps ---

echo ""
echo "[5/5] Deploy complete!"
echo ""
echo "Next steps:"
echo "  1. Commit the updated packages/shared/src/addresses.ts:"
echo "     git add packages/shared/src/addresses.ts"
echo "     git commit -m 'chore(addresses): populate mainnet conciergeRegistry post-deploy'"
echo "  2. Archive the broadcast artifact:"
echo "     cp contracts/broadcast/DeployAll.s.sol/5000/run-latest.json \\"
echo "        docs/deployments/$(date +%Y-%m-%d)-mainnet.json"
echo "  3. Deploy MCP server (story-194)"
echo "  4. Finalize README addresses table (story-200)"
