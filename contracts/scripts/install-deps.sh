#!/usr/bin/env bash
# Install Foundry submodule dependencies for the Concierge contracts.
# Pinned tags verified against latest stable releases 2026-06-09.
# NO third-party price-oracle library install per ADR-008 — prices via
# IAaveOracle (lib/aave-v3-origin/src/contracts/interfaces/IAaveOracle.sol).

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

forge install \
  OpenZeppelin/openzeppelin-contracts@v5.6.1 \
  aave-dao/aave-v3-origin@v3.6.0 \
  foundry-rs/forge-std@v1.16.1 \
  --no-git \
  --shallow

# Per silent-failure-hunter on PR #6: `forge install A B C` partial-success
# on re-run can leave 1/3 at stale tag while exiting 0. Assert each lib
# directory exists explicitly — a missing dir fails the script loudly
# rather than reporting vacuous success.
for lib in openzeppelin-contracts aave-v3-origin forge-std; do
  if [[ ! -d "lib/$lib" ]]; then
    echo "check-deps: lib/$lib missing after install — forge install may have partial-failed" >&2
    exit 1
  fi
done

echo "Foundry deps installed (OZ v5.6.1 + aave-v3-origin v3.6.0 + forge-std v1.16.1)."
