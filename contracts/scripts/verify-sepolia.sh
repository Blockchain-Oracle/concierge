#!/usr/bin/env bash
# verify-sepolia.sh — loops over deployed Sepolia contracts and verifies each on Mantlescan.
#
# Fallback for in-line `--verify` failures (Mantlescan can be slow to index).
# Idempotent: re-running a contract that is already verified is a no-op (API returns OK).
#
# Required env vars:
#   MANTLE_SEPOLIA_RPC_URL
#   MANTLESCAN_SEPOLIA_API_KEY
#
# Usage:
#   bash contracts/scripts/verify-sepolia.sh
#
# Run from the repo root.

set -euo pipefail

: "${MANTLE_SEPOLIA_RPC_URL:?MANTLE_SEPOLIA_RPC_URL must be set}"
: "${MANTLESCAN_SEPOLIA_API_KEY:?MANTLESCAN_SEPOLIA_API_KEY must be set}"

BROADCAST_JSON="contracts/broadcast/DeployAll.s.sol/5003/run-latest.json"

if [[ ! -f "$BROADCAST_JSON" ]]; then
  echo "ERROR: broadcast artifact not found at $BROADCAST_JSON"
  echo "Run DeployAll.s.sol --broadcast first."
  exit 1
fi

# Extract (contractName, contractAddress) pairs from CREATE transactions
mapfile -t CONTRACTS < <(
  jq -r '
    .transactions[]
    | select(.transactionType == "CREATE")
    | select(.contractName != null)
    | "\(.contractName) \(.contractAddress)"
  ' "$BROADCAST_JSON"
)

if [[ ${#CONTRACTS[@]} -eq 0 ]]; then
  echo "ERROR: no CREATE transactions found in broadcast artifact"
  exit 1
fi

echo "Verifying ${#CONTRACTS[@]} contracts on Mantle Sepolia (chain 5003)…"

FAILED=0
for entry in "${CONTRACTS[@]}"; do
  NAME=$(echo "$entry" | awk '{print $1}')
  ADDR=$(echo "$entry" | awk '{print $2}')

  echo "  $NAME ($ADDR) …"

  # Capture stderr so failures are diagnosable; print it only on error.
  # ConciergeRegistryProxy has a non-trivial constructor — pass --guess-constructor-args
  # so forge can recover the ABI-encoded init calldata from the broadcast artifact.
  EXTRA_FLAGS=()
  if [[ "$NAME" == "ConciergeRegistryProxy" ]]; then
    EXTRA_FLAGS+=(--guess-constructor-args)
  fi

  STDERR_OUT=$(mktemp)
  if forge verify-contract \
      --chain 5003 \
      --rpc-url "$MANTLE_SEPOLIA_RPC_URL" \
      --etherscan-api-key "$MANTLESCAN_SEPOLIA_API_KEY" \
      --verifier-url "https://api-sepolia.mantlescan.xyz/api" \
      --watch \
      "${EXTRA_FLAGS[@]}" \
      "$ADDR" "$NAME" 2>"$STDERR_OUT"; then
    echo "    OK"
  else
    echo "    FAILED"
    echo "    --- forge stderr ---"
    cat "$STDERR_OUT"
    echo "    ---"
    FAILED=$((FAILED + 1))
  fi
  rm -f "$STDERR_OUT"
done

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "WARNING: $FAILED contract(s) failed verification. Re-run this script to retry."
  exit 1
fi

echo ""
echo "All contracts verified ✓"
