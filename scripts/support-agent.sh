#!/bin/bash
# Real-time support agent — launchd entrypoint.
#
# Phase C scope: live but inert. The script polls the Zoho Inbox via
# zoho-cli.mjs list-pending and either prints a context bundle per pending
# thread (dry-run) or applies the `Drafto/Support/Seen` label so the thread
# disappears from the agent's pending set (label-only). It does NOT invoke
# Claude Code, does NOT reply to threads, does NOT create GitHub issues,
# and does NOT move folders. Phase D+ will lift these gates progressively
# (escalate → auto-reply → full).
#
# Modes (exactly one of --dry-run or --label-only is required):
#   --dry-run                  Build and print bundles. No Zoho mutations.
#                              Useful for golden-run testing and for
#                              eyeballing live-API output.
#   --label-only               Apply Drafto/Support/Seen to each pending
#                              thread. Live API mutation, but inert from
#                              the customer's perspective. Phase C live mode.
#   --fixture <path>           (--dry-run only) Replay a captured Zoho
#                              list-pending JSON instead of hitting the
#                              live API. Refused under --label-only because
#                              fixtures contain synthetic threadIds that
#                              don't exist in the real mailbox.
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
LABEL_ONLY=0
FIXTURE=""
usage() {
  cat <<EOF
Usage: $0 (--dry-run | --label-only) [--fixture <path-to-list-pending.json>]

Exactly one of --dry-run or --label-only is required (Phase C). The agent
does not yet reply, file issues, move folders, or invoke Claude.

  --dry-run      Print the context bundle that Claude would receive.
                 No Zoho mutations.
  --label-only   Apply Drafto/Support/Seen to each pending thread.
                 Live API mutation. Refuses --fixture.
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --label-only) LABEL_ONLY=1; shift ;;
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

if [[ "$DRY_RUN" -eq 0 && "$LABEL_ONLY" -eq 0 ]]; then
  echo "ERROR: must specify --dry-run or --label-only (Phase C)." >&2
  usage >&2
  exit 2
fi
if [[ "$DRY_RUN" -eq 1 && "$LABEL_ONLY" -eq 1 ]]; then
  echo "ERROR: --dry-run and --label-only are mutually exclusive." >&2
  exit 2
fi
if [[ "$LABEL_ONLY" -eq 1 && -n "$FIXTURE" ]]; then
  echo "ERROR: --fixture cannot be combined with --label-only (would mutate Zoho with synthetic threadIds)." >&2
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
log "=== support-agent run started (dry-run=$DRY_RUN, label-only=$LABEL_ONLY, fixture=${FIXTURE:-none}) ==="

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

# ── Per-thread loop ─────────────────────────────────────────────────────────
# list-pending dedupes in zoho-cli.mjs, so each iteration here corresponds to
# a unique conversation. The list entry IS the latest message in that thread
# (Zoho returns newest-first; lib keeps first occurrence). Singleton inbound
# messages don't get a threadId assigned by Zoho until they're replied to —
# we treat those as 1-message threads keyed off messageId for tracking, and
# label them via add-message-label instead of add-label.
LABEL_FAILURES=0
for THREAD_INDEX in $(seq 0 $((PENDING_COUNT - 1))); do
  ENTRY=$(echo "$PENDING" | jq ".[${THREAD_INDEX}]")
  THREAD_ID=$(echo "$ENTRY" | jq -r '.threadId // empty')
  MSG_ID=$(echo "$ENTRY" | jq -r '.messageId // .id // empty')
  FOLDER_ID=$(echo "$ENTRY" | jq -r '.folderId // empty')
  TRACK_ID="${THREAD_ID:-$MSG_ID}"
  if [[ -z "$TRACK_ID" ]]; then
    log "WARNING: pending entry $THREAD_INDEX has no threadId/messageId — skipping"
    continue
  fi

  if [[ "$LABEL_ONLY" -eq 1 ]]; then
    if [[ -n "$THREAD_ID" ]]; then
      log "Applying Drafto/Support/Seen to thread $THREAD_ID"
      if node "$SCRIPT_DIR/lib/zoho-cli.mjs" add-label "$THREAD_ID" "Drafto/Support/Seen" \
          >>"$LOG_FILE" 2>&1; then
        log "Labelled thread $THREAD_ID"
      else
        LABEL_FAILURES=$((LABEL_FAILURES + 1))
        log "ERROR: add-label failed for thread $THREAD_ID"
      fi
    elif [[ -n "$MSG_ID" ]]; then
      log "Applying Drafto/Support/Seen to message $MSG_ID (singleton, no threadId)"
      if node "$SCRIPT_DIR/lib/zoho-cli.mjs" add-message-label "$MSG_ID" "Drafto/Support/Seen" \
          >>"$LOG_FILE" 2>&1; then
        log "Labelled message $MSG_ID"
      else
        LABEL_FAILURES=$((LABEL_FAILURES + 1))
        log "ERROR: add-message-label failed for message $MSG_ID"
      fi
    fi
    continue
  fi

  # --dry-run path: build a context bundle and print it.
  log "Building bundle for $TRACK_ID (threadId=${THREAD_ID:-<none>}, msgId=$MSG_ID)"
  if [[ -n "$FIXTURE" ]]; then
    # Fixtures already wrap messages in {threadId, messages, headers, ...}.
    THREAD_JSON="$ENTRY"
    HEADERS_JSON=$(echo "$ENTRY" | jq '.headers // {}')
  else
    if [[ -n "$THREAD_ID" ]]; then
      # get-thread returns a raw [<msg>, ...] array. Wrap it as
      # {threadId, messages} so bundle.thread has the same shape as fixtures.
      if MSGS_JSON=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" get-thread "$THREAD_ID" 2>>"$LOG_FILE"); then
        THREAD_JSON=$(jq -n \
          --argjson messages "$MSGS_JSON" \
          --arg threadId "$THREAD_ID" \
          '{ threadId: $threadId, messages: $messages }')
      else
        log "WARNING: get-thread failed for $THREAD_ID; falling back to list-pending entry"
        THREAD_JSON=$(jq -n --argjson entry "$ENTRY" --arg threadId "$THREAD_ID" \
          '{ threadId: $threadId, messages: [$entry] }')
      fi
    else
      # No threadId yet — treat the list-pending entry as a 1-message thread.
      THREAD_JSON=$(jq -n --argjson entry "$ENTRY" \
        '{ threadId: null, messages: [$entry] }')
    fi
    # Headers come from the list-pending entry's message id+folder id, since
    # that entry IS the latest message in the thread. The header endpoint is
    # folder-scoped (see zoho-cli.mjs ZOHO_API_PATHS.messageHeader).
    if [[ -n "$MSG_ID" && -n "$FOLDER_ID" ]]; then
      HEADERS_JSON=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" get-headers "$FOLDER_ID" "$MSG_ID" \
        2>>"$LOG_FILE" || echo '{}')
    else
      log "WARNING: pending entry for $TRACK_ID has no folderId/messageId — headers omitted"
      HEADERS_JSON='{}'
    fi
  fi

  # TODO(phase-D): replace the hardcoded `state` placeholders below with values
  # computed from scripts/lib/state.mjs + scripts/lib/policy.mjs before this
  # bundle is fed to Claude. Phase C only prints bundles in dry-run mode and
  # only labels in --label-only, so leaving the loop guard / human-intervention
  # flags as constants is harmless — but they MUST be wired up before Phase D
  # flips on auto-classify+escalate, otherwise rateLimitOk and humanIntervened
  # will never trip.
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

  log "DRY-RUN: would invoke claude with the following bundle:"
  echo "$BUNDLE" | tee -a "$LOG_FILE"
  log "DRY-RUN: end of bundle for $TRACK_ID"
done

if [[ "$LABEL_ONLY" -eq 1 && "$LABEL_FAILURES" -gt 0 ]]; then
  log "ERROR: $LABEL_FAILURES of $PENDING_COUNT label operations failed"
  exit 1
fi

log "=== support-agent run completed in $(( $(date +%s) - START_TIME ))s ==="
