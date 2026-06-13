#!/usr/bin/env bash
# Concierge Mantle Agent — RealClaw skill post-install configurator.
#
# Security model summary (see __tests__/install-script.test.ts + the
# referenced CWE IDs for the regression gates):
#   * CWE-74  — strict allow-list ^[A-Za-z0-9_-]{1,64}$ on user_id;
#               CWE-74-class URL allow-list on CONCIERGE_URL override.
#   * CWE-601 — production OAuth endpoint is HARDCODED; --dev gate
#               for local-dev override only; --dev=value rejected
#               loudly so a maintainer typo can't silently bypass.
#   * CWE-276 — umask 077 BEFORE mkdir, `install -m 600 /dev/null`
#               creates the file with the right mode FIRST, redirect
#               truncates in place preserving 0600. Explicit chmods
#               are belt-and-suspenders.
#   * CWE-703 — `[[ -t 0 ]]` TTY check refuses piped invocation;
#               documented threat boundary (does NOT defend against a
#               local PTY wrapper like script(1) — see SKILL.md).

set -euo pipefail

readonly PROD_URL='https://concierge.xyz'
# Round-2 (security MEDIUM): CONCIERGE_URL must shape-match a sane HTTPS
# origin. Same CWE-74 reasoning as user_id — no quotes/newlines escape
# into the JSON heredoc.
readonly URL_RE='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
# Round-2: user_id allow-list lifted to a top-level readonly so the
# function (and tests) can `source` it without re-defining.
readonly USER_ID_RE='^[A-Za-z0-9_-]{1,64}$'

CONFIG_DIR="${HOME}/.concierge"
CONFIG_FILE="${CONFIG_DIR}/config.json"
DEV_MODE=0

# Round-2 (security info #3): reject --dev=value so a maintainer typo
# can't silently fall through to prod URL without applying the override.
for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE=1 ;;
    --dev=*)
      printf '[concierge] FATAL: --dev does not accept a value. Pass --dev (with no =value) and set CONCIERGE_URL in the environment.\n' >&2
      exit 2
      ;;
    -h|--help)
      cat >&2 <<USAGE
Usage: install.sh [--dev]
  --dev   Allow CONCIERGE_URL env override (local-dev only).
          Without --dev, the OAuth endpoint is locked to ${PROD_URL}.
USAGE
      exit 0
      ;;
    *) printf '[concierge] unknown arg: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log() { printf '[concierge] %s\n' "$*" >&2; }

# Round-2 CRITICAL: validator now BEHAVIORALLY tested via
# `source install.sh && validate_user_id 'evil"'`. Source-grep tests
# alone would have green-lit a regression to `.*`.
validate_user_id() {
  local uid="$1"
  if [[ ! "$uid" =~ $USER_ID_RE ]]; then
    log "rejected user id (must match [A-Za-z0-9_-]{1,64}). For OAuth, press Enter at the prompt."
    return 1
  fi
}

# Round-2 (code review #2 — CWE-74 class): symmetric URL validation so
# a hostile --dev wrapper can't inject quotes/newlines via CONCIERGE_URL
# into the config.json heredoc.
validate_url() {
  local url="$1"
  if [[ ! "$url" =~ $URL_RE ]]; then
    log "rejected URL (must be http(s)://host[:port][/path] with no quotes/newlines)."
    return 1
  fi
}

if [[ "$DEV_MODE" -eq 1 ]]; then
  # Round-2 (code review #1): only emit the override warning when the
  # value ACTUALLY differs from prod — was self-referential confusion.
  CONCIERGE_URL="${CONCIERGE_URL:-$PROD_URL}"
  if [[ "$CONCIERGE_URL" != "$PROD_URL" ]]; then
    log "WARNING: --dev mode — using ${CONCIERGE_URL} instead of ${PROD_URL}"
  fi
  if ! validate_url "$CONCIERGE_URL"; then
    exit 2
  fi
else
  CONCIERGE_URL="$PROD_URL"
fi
OAUTH_URL="${CONCIERGE_URL}/oauth/authorize?client=skill"

write_config() {
  local user_id="$1"
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  umask 077
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  install -m 600 /dev/null "$CONFIG_FILE"
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

# Round-2 (test gap #1): guard so tests can `source install.sh` to
# behaviorally test validate_user_id / validate_url without running main.
# A sourced shell sets $0 to its own name (not the path), so the
# BASH_SOURCE[0] vs ${0} comparison reliably distinguishes.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
