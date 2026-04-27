#!/bin/bash
# Real-time support agent — launchd entrypoint.
#
# Phase D scope: auto-classify + escalate. The script polls the Zoho Inbox
# via zoho-cli.mjs list-pending and, depending on the mode, either prints a
# bundle (dry-run), applies the `Drafto/Support/Seen` label (label-only — Phase
# C fallback), or invokes Claude with the bundle and lets it apply
# `Drafto/Support/NeedsHuman` / move to `Drafto/Support/Spam` and email an
# admin notification (auto-classify — Phase D live mode). Auto-replies and
# GitHub issue creation remain off until Phase E / F respectively; the prompt
# enforces this via the bundle's `config.phase`.
#
# Modes (exactly one of --dry-run, --label-only, --auto-classify is required):
#   --dry-run                  Build and print bundles. No Zoho mutations.
#                              Useful for golden-run testing and for
#                              eyeballing live-API output.
#   --label-only               Apply Drafto/Support/Seen to each pending
#                              thread. Live API mutation, but inert from the
#                              customer's perspective. Phase C live mode kept
#                              as a fallback when Claude usage is undesirable.
#   --auto-classify            Phase D live mode. For each pending thread,
#                              build a bundle (with humanIntervened/rate-limit
#                              flags from state) and invoke Claude. Claude is
#                              constrained by the prompt to only label
#                              NeedsHuman / move to Spam folder / email an
#                              admin notification — no replies, no GH issues.
#   --fixture <path>           (--dry-run only) Replay a captured Zoho
#                              list-pending JSON instead of hitting the
#                              live API. Refused under --label-only and
#                              --auto-classify because fixtures contain
#                              synthetic threadIds that don't exist in the
#                              real mailbox.
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
AUTO_CLASSIFY=0
FIXTURE=""
PHASE="D"
usage() {
  cat <<EOF
Usage: $0 (--dry-run | --label-only | --auto-classify) [--fixture <path>] [--phase <D|E|F|G>]

Exactly one of --dry-run, --label-only, or --auto-classify is required.

  --dry-run         Print the context bundle that Claude would receive.
                    No Zoho mutations.
  --label-only      Apply Drafto/Support/Seen to each pending thread.
                    Live API mutation only; no Claude. Phase C fallback.
  --auto-classify   Invoke Claude per pending thread. Claude is constrained
                    by scripts/support-agent-prompt.md and the bundle's
                    config.phase to escalate (Drafto/Support/NeedsHuman +
                    admin email) or label as spam — no replies, no GH issues.
  --fixture <path>  (--dry-run only) Replay a captured Zoho list-pending JSON.
                    Refused under --label-only and --auto-classify.
  --phase <D|...>   Override the phase advertised to Claude (default: D).
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --label-only) LABEL_ONLY=1; shift ;;
    --auto-classify) AUTO_CLASSIFY=1; shift ;;
    --fixture)
      if [[ -z "${2:-}" || "${2:0:2}" == "--" ]]; then
        echo "ERROR: --fixture requires a path argument" >&2
        usage >&2
        exit 2
      fi
      FIXTURE="$2"
      shift 2
      ;;
    --phase)
      if [[ -z "${2:-}" || "${2:0:2}" == "--" ]]; then
        echo "ERROR: --phase requires a value (D|E|F|G)" >&2
        usage >&2
        exit 2
      fi
      PHASE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

MODE_COUNT=$((DRY_RUN + LABEL_ONLY + AUTO_CLASSIFY))
if [[ "$MODE_COUNT" -eq 0 ]]; then
  echo "ERROR: must specify --dry-run, --label-only, or --auto-classify." >&2
  usage >&2
  exit 2
fi
if [[ "$MODE_COUNT" -gt 1 ]]; then
  echo "ERROR: --dry-run / --label-only / --auto-classify are mutually exclusive." >&2
  exit 2
fi
if [[ -n "$FIXTURE" && "$DRY_RUN" -eq 0 ]]; then
  echo "ERROR: --fixture is only valid with --dry-run (synthetic threadIds aren't in the real mailbox)." >&2
  exit 2
fi
case "$PHASE" in
  D|E|F|G) ;;
  *) echo "ERROR: --phase must be one of D, E, F, G (got '$PHASE')" >&2; exit 2 ;;
esac

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

STATE_FILE="$REPO_ROOT/logs/support-state.json"

START_TIME=$(date +%s)
log "=== support-agent run started (dry-run=$DRY_RUN, label-only=$LABEL_ONLY, auto-classify=$AUTO_CLASSIFY, phase=$PHASE, fixture=${FIXTURE:-none}) ==="

# auto-classify requires the `claude` CLI on PATH.
if [[ "$AUTO_CLASSIFY" -eq 1 ]] && ! command -v claude >/dev/null 2>&1; then
  log "ERROR: --auto-classify requires the claude CLI on PATH (looked in: \$PATH=$PATH)"
  exit 1
fi

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

  # --dry-run / --auto-classify path: build a context bundle.
  log "Building bundle for $TRACK_ID (threadId=${THREAD_ID:-<none>}, msgId=$MSG_ID)"
  THREAD_JSON='null'
  HEADERS_JSON='{}'
  if [[ -n "$FIXTURE" ]]; then
    # Fixtures already wrap messages in {threadId, messages, headers, ...}.
    THREAD_JSON=$(echo "$ENTRY" | jq '{ threadId: (.threadId // null), messages: (.messages // [.]) }')
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
      if HEADERS_JSON_TMP=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" get-headers "$FOLDER_ID" "$MSG_ID" \
          2>>"$LOG_FILE"); then
        HEADERS_JSON="$HEADERS_JSON_TMP"
      else
        log "WARNING: get-headers failed for $TRACK_ID (folder=$FOLDER_ID, msg=$MSG_ID); headers omitted"
      fi
    else
      log "WARNING: pending entry for $TRACK_ID has no folderId/messageId — headers omitted"
    fi
  fi

  # Read state once per bundle so humanIntervened / rateLimitOk /
  # shouldNotifyAdmin reflect what we'd actually do. Missing file → empty
  # state (build-bundle.mjs handles this).
  if [[ -f "$STATE_FILE" ]]; then
    STATE_JSON=$(cat "$STATE_FILE")
  else
    STATE_JSON='{}'
  fi

  # build-bundle.mjs takes one combined JSON on stdin. Keeps the bundle
  # construction in Node where the policy.mjs functions live, instead of
  # duplicating the logic in `jq -n`.
  BUILD_INPUT=$(jq -n \
    --argjson pending "$ENTRY" \
    --argjson thread "$THREAD_JSON" \
    --argjson headers "$HEADERS_JSON" \
    --argjson state "$STATE_JSON" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg adminEmail "$ADMIN_EMAIL" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    '{
       pending: $pending,
       thread: $thread,
       headers: $headers,
       state: $state,
       config: {
         allowlist: $allowlist,
         adminEmail: $adminEmail,
         oauthUserEmail: $oauthUserEmail,
         phase: $phase
       }
     }')
  if ! BUNDLE=$(echo "$BUILD_INPUT" | node "$SCRIPT_DIR/lib/build-bundle.mjs" 2>>"$LOG_FILE"); then
    log "ERROR: build-bundle failed for $TRACK_ID"
    continue
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    # The bundle contains the customer's email body, sender address, and
    # full headers (PII). Print it to stdout so the operator running
    # --dry-run interactively can see it, but do NOT tee into LOG_FILE —
    # the rotating logs/support/*.log files are 0600 + 30-day retention but
    # we don't want PII persisted there. (Deferred from PR #335; this PR
    # is the Phase D rollout that triggers the deferral.)
    log "DRY-RUN: bundle for $TRACK_ID (printed to stdout only; not logged)"
    echo "$BUNDLE"
    continue
  fi

  # ── --auto-classify path ────────────────────────────────────────────────
  # Hand the prompt + bundle to `claude -p` and capture stdout. Claude is
  # constrained by the prompt + bundle.config.phase to only escalate or
  # spam-folder in Phase D — the prompt itself enforces this. We don't pipe
  # the bundle on real stdin because `claude -p` takes the prompt as an
  # argument and ignores stdin.
  PROMPT_FILE="$SCRIPT_DIR/support-agent-prompt.md"
  if [[ ! -f "$PROMPT_FILE" ]]; then
    log "ERROR: prompt file missing: $PROMPT_FILE"
    exit 1
  fi
  PROMPT_TEXT=$(cat "$PROMPT_FILE")
  CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
    "$PROMPT_TEXT" "$BUNDLE")

  log "Invoking claude for $TRACK_ID (phase=$PHASE)"
  CLAUDE_OUTPUT_FILE=$(mktemp -t support-agent-out.XXXXXX)
  if ! claude -p "$CLAUDE_INPUT" --dangerously-skip-permissions \
      >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE"; then
    log "ERROR: claude exited non-zero for $TRACK_ID"
    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
    rm -f "$CLAUDE_OUTPUT_FILE"
    continue
  fi
  cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
  # The prompt instructs Claude to end with a single line:
  #   thread=<id> action=<x> issue=<n|->
  # The strict regex avoids false positives from mid-stream reasoning that
  # happens to start with `thread=` (e.g. quoting customer text), and
  # rejects partial/malformed lines so the action handler doesn't get a
  # half-parsed value.
  SUMMARY_LINE=$(grep -E '^thread=[^ ]+ action=[^ ]+ issue=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
  rm -f "$CLAUDE_OUTPUT_FILE"
  if [[ -z "$SUMMARY_LINE" ]]; then
    log "WARNING: no well-formed summary line returned by claude for $TRACK_ID"
    continue
  fi
  log "Claude summary: $SUMMARY_LINE"
  ACTION=$(echo "$SUMMARY_LINE" | sed -E 's/.*action=([^ ]+).*/\1/')

  # If Claude escalated (NeedsHuman), it should also have fired an admin
  # email per the prompt. Bump the cooldown cursor here so the next run
  # respects it. Phase-disallowed actions (auto-replied in Phase D,
  # filed-issue in Phase D/E) are treated as hard errors so an LLM
  # regression doesn't slip past the prompt's gate silently.
  case "$ACTION" in
    escalated)
      if ! node "$SCRIPT_DIR/lib/state-cli.mjs" bump-notification "$TRACK_ID" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
        log "WARNING: state-cli bump-notification failed for $TRACK_ID"
      fi
      ;;
    spammed|noop|sync-comment|sync-state)
      : # No state change required at this stage.
      ;;
    auto-replied)
      if [[ "$PHASE" == "D" ]]; then
        log "ERROR: claude returned auto-replied under Phase D for $TRACK_ID — prompt phase gate violated"
        exit 1
      fi
      # Phase E+: bump-counters here once the auto-reply path is wired in.
      ;;
    filed-issue)
      if [[ "$PHASE" =~ ^[DE]$ ]]; then
        log "ERROR: claude returned filed-issue under Phase $PHASE for $TRACK_ID — prompt phase gate violated"
        exit 1
      fi
      ;;
    *)
      log "WARNING: unrecognised action '$ACTION' from claude for $TRACK_ID"
      ;;
  esac
done

if [[ "$LABEL_ONLY" -eq 1 && "$LABEL_FAILURES" -gt 0 ]]; then
  log "ERROR: $LABEL_FAILURES of $PENDING_COUNT label operations failed"
  exit 1
fi

log "=== support-agent run completed in $(( $(date +%s) - START_TIME ))s ==="
