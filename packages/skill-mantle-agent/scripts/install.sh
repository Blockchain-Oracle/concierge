#!/usr/bin/env bash
# Concierge Mantle Agent — RealClaw skill post-install configurator.
#
# Security model (per round-1 review):
#   * user_id is strict-validated to ^[A-Za-z0-9_-]{1,64}$ (CWE-74 — JSON
#     injection via heredoc was the round-0 bug)
#   * OAuth endpoint is HARDCODED to https://concierge.xyz; --dev flag
#     opt-in lets CONCIERGE_URL override for local dev only (CWE-601)
#   * `umask 077` is set BEFORE mkdir so CONFIG_DIR is 0700; explicit
#     chmod after write nails CONFIG_FILE to 0600 even if it pre-existed
#     with permissive bits (CWE-276)
#   * TTY check via `[[ -t 0 ]]` so piped invocation (`curl | bash`)
#     fails LOUD instead of silently exiting on EOF (CWE-703)

set -euo pipefail

readonly PROD_URL='https://concierge.xyz'

CONFIG_DIR="${HOME}/.concierge"
CONFIG_FILE="${CONFIG_DIR}/config.json"
DEV_MODE=0

# Parse args FIRST — --dev gates the CONCIERGE_URL override.
for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE=1 ;;
    -h|--help)
      cat >&2 <<USAGE
Usage: install.sh [--dev]
  --dev   Allow CONCIERGE_URL env override (local-dev only).
          Without --dev, the OAuth endpoint is locked to ${PROD_URL}.
USAGE
      exit 0
      ;;
    *) printf 'unknown arg: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if [[ "$DEV_MODE" -eq 1 ]]; then
  CONCIERGE_URL="${CONCIERGE_URL:-$PROD_URL}"
  printf '[concierge] WARNING: --dev mode — using %s instead of %s\n' \
    "$CONCIERGE_URL" "$PROD_URL" >&2
else
  CONCIERGE_URL="$PROD_URL"
fi
OAUTH_URL="${CONCIERGE_URL}/oauth/authorize?client=skill"

log() { printf '[concierge] %s\n' "$*" >&2; }

# Strict allow-list. Anything else → reject; no escaping path can sneak
# `"` / `\` / control chars / `}` into the JSON write.
validate_user_id() {
  local uid="$1"
  if [[ ! "$uid" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    log "rejected user id (must match [A-Za-z0-9_-]{1,64}). For OAuth, press Enter at the prompt."
    return 1
  fi
}

write_config() {
  local user_id="$1"
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # umask + explicit chmod nails 0700/0600 even if dir/file pre-existed.
  umask 077
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  # `install -m 600 /dev/null` creates the file with the right mode
  # FIRST, so the cat redirect doesn't preserve an inode's old perms.
  install -m 600 /dev/null "$CONFIG_FILE"
  # User id is allow-listed; URL is either hardcoded or --dev-provided.
  # Still safe to interpolate, but using printf with the validated values.
  cat > "$CONFIG_FILE" <<EOF
{
  "userId": "${user_id}",
  "url": "${CONCIERGE_URL}",
  "createdAt": "${timestamp}"
}
EOF
  chmod 600 "$CONFIG_FILE"
  log "wrote ${CONFIG_FILE} (mode 0600)"
}

main() {
  # CWE-703: refuse to run if stdin isn't a TTY. set -e + EOF on read
  # would otherwise silently exit, masking install failure.
  if [[ ! -t 0 ]]; then
    log "FATAL: stdin is not a TTY. Run this script interactively."
    exit 1
  fi

  if [[ -f "$CONFIG_FILE" ]]; then
    printf 'existing config at %s — overwrite? [y/N] ' "$CONFIG_FILE" >&2
    local answer
    read -r answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) log "keeping existing config; exiting"; exit 0 ;;
    esac
  fi

  printf 'concierge.xyz user id (or Enter for OAuth): ' >&2
  local uid
  read -r uid

  if [[ -z "$uid" ]]; then
    log "no user id provided — open this URL to complete OAuth:"
    log "  $OAUTH_URL"
    log "re-run this script after OAuth completes."
    exit 0
  fi

  if ! validate_user_id "$uid"; then
    exit 2
  fi

  write_config "$uid"
  log "done. test with: claude mcp list | grep concierge"
}

main "$@"
