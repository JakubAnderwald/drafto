#!/bin/bash
# Real-time support agent — launchd entrypoint.
#
# Phase A scope: dry-run only. The script polls the Zoho Inbox via
# zoho-cli.mjs list-pending, builds a context bundle per pending thread,
# and prints the bundle(s) to stdout. It does NOT invoke Claude Code,
# does NOT reply to threads, does NOT create GitHub issues, and does NOT
# touch labels or folders. Phase C+ will lift these gates progressively
# (read-only labels → escalate → auto-reply → full).
#
# Modes:
#   --dry-run                  Phase A. Required until Phase C ships.
#   --fixture <path>           Replay a captured Zoho list-pending JSON
#                              instead of hitting the live API. Useful for
#                              unit-test-style golden runs.
#
# Failure mode: if the script exits non-zero, the cleanup trap files a
# `nightly-failure`-labelled GitHub issue, mirroring the existing pattern
# in scripts/nightly-support.sh.

set -euo pipefail

# ── PATH / locale (launchd provides minimal env) ────────────────────────────
export PATH="$HOME/.local/bin:$PATH"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# ── Args ────────────────────────────────────────────────────────────────────
DRY_RUN=0
FIXTURE=""
usage() {
  cat <<EOF
Usage: $0 --dry-run [--fixture <path-to-list-pending.json>]

Phase A scope — dry-run is required. The agent does not yet make any
changes to Zoho or GitHub.
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --fixture)
      if [[ -z "${2:-}" || "${2:0:2}" == "--" ]]; then
        echo "ERROR: --fixture requires a path argument" >&2
        usage >&2
        exit 2
      fi
      FIXTURE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$DRY_RUN" -ne 1 ]]; then
  echo "ERROR: Phase A requires --dry-run." >&2
  usage >&2
  exit 2
fi

# ── Allowlist env (single source of truth for the support pipeline) ─────────
if [[ -f "$HOME/drafto-secrets/support-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/drafto-secrets/support-env.sh"
fi
SUPPORT_ALLOWLIST="${SUPPORT_ALLOWLIST:-jakub@anderwald.info,joanna@anderwald.info}"
ADMIN_EMAIL="${SUPPORT_ADMIN_EMAIL:-jakub@anderwald.info}"

# ── Paths, logs, lock ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
umask 077
LOG_DIR="$REPO_ROOT/logs/support"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/support-agent-$(date +%Y-%m-%d).log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
find "$LOG_DIR" -type f -name 'support-agent-*.log' -mtime +30 -delete 2>/dev/null || true

LOCK_FILE="$REPO_ROOT/logs/support-agent.lock"
# Portable PID-file lock (macOS does not ship flock). Stale locks (PID no
# longer alive) are reaped automatically.
if [[ -f "$LOCK_FILE" ]]; then
  EXISTING_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "[$(date '+%H:%M:%S')] Another support-agent run is in progress (pid=$EXISTING_PID), exiting." \
      | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo "$$" > "$LOCK_FILE"

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# ── Failure notification (mirrors nightly-support.sh) ───────────────────────
cleanup() {
  local exit_code=$?
  rm -f "$LOCK_FILE"
  if [[ $exit_code -ne 0 ]]; then
    log "ERROR: support-agent exiting with code $exit_code"
    # IMPORTANT: this regex intentionally drops any line that lacks a
    # `[HH:MM:SS]` log() prefix — including the JSON context bundles printed
    # in dry-run mode, which contain customer email bodies / addresses /
    # headers (PII). Don't loosen this filter without redacting bundle
    # contents first; otherwise `nightly-failure` GitHub issues could leak
    # customer data via the failure-issue body.
    local sanitized_log
    sanitized_log=$(grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' "$LOG_FILE" 2>/dev/null | tail -20 \
      || echo "No log available")
    if command -v gh &>/dev/null; then
      gh issue create \
        --repo JakubAnderwald/drafto \
        --title "support-agent failed ($(date +%Y-%m-%d))" \
        --label "nightly-failure" \
        --body "$(cat <<EOF
The real-time support agent exited with code \`$exit_code\` on $(date '+%Y-%m-%d at %H:%M:%S').

### Script log (timestamped entries only)

\`\`\`
$sanitized_log
\`\`\`

Full log on the Mac mini: \`logs/support/support-agent-$(date +%Y-%m-%d).log\` (gitignored).
EOF
        )" 2>/dev/null || log "WARNING: failed to file failure issue"
    else
      log "WARNING: gh CLI unavailable, no failure issue filed"
    fi
  fi
}
trap cleanup EXIT

# ── OAuth precondition + identity ───────────────────────────────────────────
OAUTH_FILE="$HOME/drafto-secrets/zoho-oauth.json"
if [[ -z "$FIXTURE" && ! -f "$OAUTH_FILE" ]]; then
  log "ERROR: $OAUTH_FILE not found."
  log "       Run: node scripts/lib/setup-zoho-oauth.mjs"
  exit 1
fi
# Derive the OAuth user's email from the secrets file rather than hardcoding,
# so the bundle handed to Claude matches whatever sender zoho-cli.mjs actually
# uses (cfg.primaryEmail). Falls back to a sensible default for fixture-only
# runs where the secrets file isn't required.
if [[ -f "$OAUTH_FILE" ]]; then
  OAUTH_USER_EMAIL=$(jq -r '.primary_email // empty' "$OAUTH_FILE" 2>/dev/null || echo "")
fi
OAUTH_USER_EMAIL="${OAUTH_USER_EMAIL:-support@drafto.eu}"

START_TIME=$(date +%s)
log "=== support-agent run started (dry-run=$DRY_RUN, fixture=${FIXTURE:-none}) ==="

# ── Cheap pre-check: list-pending ───────────────────────────────────────────
if [[ -n "$FIXTURE" ]]; then
  if [[ ! -f "$FIXTURE" ]]; then
    log "ERROR: fixture file not found: $FIXTURE"
    exit 1
  fi
  PENDING=$(cat "$FIXTURE")
  log "Pre-check: loaded fixture $FIXTURE"
else
  if ! PENDING=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" list-pending 2>>"$LOG_FILE"); then
    log "ERROR: zoho-cli list-pending failed"
    exit 1
  fi
fi

PENDING_COUNT=$(echo "$PENDING" | jq 'length' 2>/dev/null || echo "0")
log "Pre-check: $PENDING_COUNT pending Zoho threads"

if [[ "$PENDING_COUNT" -eq 0 ]]; then
  log "No work; exiting."
  log "=== support-agent run completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── Build & emit context bundles (Phase A: print only) ──────────────────────
for THREAD_INDEX in $(seq 0 $((PENDING_COUNT - 1))); do
  THREAD_ID=$(echo "$PENDING" \
    | jq -r ".[${THREAD_INDEX}].threadId // .[${THREAD_INDEX}].messageId // .[${THREAD_INDEX}].id // empty")
  if [[ -z "$THREAD_ID" ]]; then
    log "WARNING: pending entry $THREAD_INDEX has no threadId/messageId — skipping"
    continue
  fi
  log "Building bundle for thread $THREAD_ID"

  # In a real run we'd call zoho-cli.mjs get-thread + get-headers here. In
  # dry-run with a fixture, the fixture entry IS the thread payload and we
  # pass it through as-is. In dry-run against the live API, only fetch when
  # we have OAuth (we already verified above).
  if [[ -n "$FIXTURE" ]]; then
    THREAD_JSON=$(echo "$PENDING" | jq ".[${THREAD_INDEX}]")
    HEADERS_JSON=$(echo "$THREAD_JSON" | jq '.headers // {}')
  else
    if ! THREAD_JSON=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" get-thread "$THREAD_ID" 2>>"$LOG_FILE"); then
      log "ERROR: get-thread failed for $THREAD_ID; skipping"
      continue
    fi
    LATEST_MSG_ID=$(echo "$THREAD_JSON" | jq -r '.messages[-1].messageId // .messages[-1].id // empty')
    if [[ -n "$LATEST_MSG_ID" ]]; then
      HEADERS_JSON=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" get-headers "$LATEST_MSG_ID" 2>>"$LOG_FILE" || echo '{}')
    else
      HEADERS_JSON='{}'
    fi
  fi

  # TODO(phase-D): replace the hardcoded `state` placeholders below with values
  # computed from scripts/lib/state.mjs + scripts/lib/policy.mjs before this
  # bundle is fed to Claude. Phase A only prints bundles, so leaving the loop
  # guard / human-intervention flags as constants is harmless — but they MUST
  # be wired up before Phase D flips on auto-classify+escalate, otherwise
  # rateLimitOk and humanIntervened will never trip.
  BUNDLE=$(jq -n \
    --argjson thread "$THREAD_JSON" \
    --argjson headers "$HEADERS_JSON" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg adminEmail "$ADMIN_EMAIL" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    '{
       kind: "inbound_thread",
       thread: $thread,
       headers: $headers,
       history: {},
       state: { humanIntervened: false, rateLimitOk: true, shouldNotifyAdmin: true },
       config: {
         allowlist: ($allowlist | split(",") | map(ascii_downcase | gsub("^\\s+|\\s+$"; ""))),
         adminEmail: $adminEmail,
         oauthUserEmail: $oauthUserEmail
       }
     }')

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would invoke claude with the following bundle:"
    echo "$BUNDLE" | tee -a "$LOG_FILE"
    log "DRY-RUN: end of bundle for $THREAD_ID"
  else
    log "ERROR: live mode is not implemented yet (Phase C+)."
    exit 1
  fi
done

log "=== support-agent run completed in $(( $(date +%s) - START_TIME ))s ==="
