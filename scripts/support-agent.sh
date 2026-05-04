#!/bin/bash
# Real-time support agent — launchd entrypoint.
#
# Phase D/E/F/G scope: auto-classify + escalate, auto-reply for high-confidence
# questions (Phase E), file GitHub issues for bug/feature (Phase F), forward
# GitHub issue comments back to the linked Zoho thread (Phase F via
# --comment-sync), and forward GitHub-issue lifecycle transitions (closed /
# reopened) to the linked Zoho thread (Phase G via --state-sync).
#
# The script polls either the Zoho Inbox (--auto-classify / --label-only /
# --dry-run) or the GitHub support-issue queue (--comment-sync /
# --state-sync), and per work unit invokes Claude with a context bundle.
# The prompt's phase gate decides what Claude may do:
#   - Phase D: label NeedsHuman / move to Spam / fire admin email.
#   - Phase E: Phase D + reply to high-confidence questions, label
#     Drafto/Support/Replied, move to Drafto/Support/Resolved, bump
#     rate-limit counters (the bash side handles the bump after Claude
#     reports `action=auto-replied`).
#   - Phase F: Phase E + `gh issue create`/`gh issue comment` for bug/feature,
#     `Drafto/Support/Issue/<n>` label, move to Resolved. Plus the
#     `--comment-sync` sweep below.
#   - Phase G: Phase F + `--state-sync` sweep that emails the customer when
#     their linked GitHub issue closes (completed / not_planned / duplicate)
#     or reopens.
#
# Modes (exactly one of --dry-run, --label-only, --auto-classify,
# --comment-sync, --state-sync):
#   --dry-run                  Build and print bundles. No Zoho mutations.
#                              Useful for golden-run testing and for
#                              eyeballing live-API output.
#   --label-only               Apply Drafto/Support/Seen to each pending
#                              thread. Live API mutation, but inert from the
#                              customer's perspective. Phase C fallback.
#   --auto-classify            Phase D+ live mode. For each pending Zoho
#                              thread, build an `inbound_thread` bundle (with
#                              humanIntervened/rate-limit flags) and invoke
#                              Claude. Claude is constrained by the prompt's
#                              phase gate (config.phase) to the actions
#                              permitted at that phase.
#   --comment-sync             Phase F+ live mode. Sweep GitHub support
#                              issues; for each, find the linked Zoho thread
#                              from the issue body footer, fetch comments
#                              newer than the per-issue cursor in
#                              support-state.json (filtering out the bot
#                              user), build a `github_comment_batch` bundle,
#                              and invoke Claude to forward each comment as a
#                              Zoho reply on the thread. Cursor is advanced
#                              after Claude reports `action=sync-comment`.
#   --state-sync               Phase G+ live mode. Sweep GitHub support
#                              issues; for each, compare the current
#                              {state, state_reason} against
#                              state.issues[<n>].lastKnownState. On the
#                              first run for an issue, record current state
#                              without firing (bootstrap). On subsequent
#                              runs, build a `github_state_change` bundle
#                              and hand to Claude — Claude composes the
#                              appropriate "fixed / won't-do / reopened"
#                              email and replies in-thread. lastKnownState +
#                              lastIssueStateSync are advanced after Claude
#                              reports `action=sync-state` (or noop).
#   --fixture <path>           (--dry-run only) Replay a captured Zoho
#                              list-pending JSON instead of hitting the
#                              live API. Refused under --label-only,
#                              --auto-classify, --comment-sync, and
#                              --state-sync because fixtures contain
#                              synthetic ids.
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
COMMENT_SYNC=0
STATE_SYNC=0
FIXTURE=""
PHASE="D"
usage() {
  cat <<EOF
Usage: $0 (--dry-run | --label-only | --auto-classify | --comment-sync | --state-sync) [--fixture <path>] [--phase <D|E|F|G>]

Exactly one of --dry-run, --label-only, --auto-classify, --comment-sync, or --state-sync is required.

  --dry-run         Print the context bundle that Claude would receive.
                    No Zoho mutations.
  --label-only      Apply Drafto/Support/Seen to each pending thread.
                    Live API mutation only; no Claude. Phase C fallback.
  --auto-classify   Invoke Claude per pending Zoho thread. Claude is
                    constrained by scripts/support-agent-prompt.md and
                    the bundle's config.phase to the actions permitted at
                    that phase.
  --comment-sync    Phase F+. Sweep GitHub support issues, find each one's
                    linked Zoho thread via the issue body footer, and forward
                    new GitHub comments to that thread. Per-issue cursor in
                    logs/support-state.json prevents re-forwarding.
  --state-sync      Phase G+. Sweep GitHub support issues, detect transitions
                    in {state, state_reason} since the per-issue
                    lastKnownState in logs/support-state.json, and email the
                    customer about closed / reopened lifecycle events.
  --fixture <path>  (--dry-run only) Replay a captured Zoho list-pending JSON.
                    Refused under --label-only / --auto-classify /
                    --comment-sync / --state-sync.
  --phase <D|...>   Override the phase advertised to Claude (default: D).
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --label-only) LABEL_ONLY=1; shift ;;
    --auto-classify) AUTO_CLASSIFY=1; shift ;;
    --comment-sync) COMMENT_SYNC=1; shift ;;
    --state-sync) STATE_SYNC=1; shift ;;
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

MODE_COUNT=$((DRY_RUN + LABEL_ONLY + AUTO_CLASSIFY + COMMENT_SYNC + STATE_SYNC))
if [[ "$MODE_COUNT" -eq 0 ]]; then
  echo "ERROR: must specify --dry-run, --label-only, --auto-classify, --comment-sync, or --state-sync." >&2
  usage >&2
  exit 2
fi
if [[ "$MODE_COUNT" -gt 1 ]]; then
  echo "ERROR: --dry-run / --label-only / --auto-classify / --comment-sync / --state-sync are mutually exclusive." >&2
  exit 2
fi
if [[ -n "$FIXTURE" && "$DRY_RUN" -eq 0 ]]; then
  echo "ERROR: --fixture is only valid with --dry-run (synthetic ids aren't in the real mailbox/repo)." >&2
  exit 2
fi
case "$PHASE" in
  D|E|F|G) ;;
  *) echo "ERROR: --phase must be one of D, E, F, G (got '$PHASE')" >&2; exit 2 ;;
esac
if [[ "$COMMENT_SYNC" -eq 1 ]] && [[ ! "$PHASE" =~ ^[FG]$ ]]; then
  echo "ERROR: --comment-sync requires --phase F or G (got '$PHASE')" >&2
  exit 2
fi
if [[ "$STATE_SYNC" -eq 1 ]] && [[ "$PHASE" != "G" ]]; then
  echo "ERROR: --state-sync requires --phase G (got '$PHASE')" >&2
  exit 2
fi

# ── Allowlist env (single source of truth for the support pipeline) ─────────
if [[ -f "$HOME/drafto-secrets/support-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/drafto-secrets/support-env.sh"
fi
SUPPORT_ALLOWLIST="${SUPPORT_ALLOWLIST:-jakub@anderwald.info,joanna@anderwald.info}"
ADMIN_EMAIL="${SUPPORT_ADMIN_EMAIL:-jakub@anderwald.info}"
SUPPORT_BOT_GH_USER="${SUPPORT_BOT_GH_USER:-JakubAnderwald}"

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

# Per-run scratch dir for downloaded Zoho attachments. Reaped by the cleanup
# trap regardless of exit code. Lives outside REPO_ROOT so a `git status`
# during a run can't surface ephemeral binaries.
ATTACHMENTS_TMP_DIR=$(mktemp -d -t drafto-support-attachments.XXXXXX)

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# ── Failure notification (mirrors nightly-support.sh) ───────────────────────
cleanup() {
  local exit_code=$?
  rm -f "$LOCK_FILE"
  # Reap the per-run attachments scratch dir. `rm -rf` on a tempdir we created
  # ourselves under TMPDIR is safe; do it before the failure-issue branch so
  # binaries don't linger if filing the issue itself fails.
  if [[ -n "${ATTACHMENTS_TMP_DIR:-}" && -d "$ATTACHMENTS_TMP_DIR" ]]; then
    rm -rf "$ATTACHMENTS_TMP_DIR"
  fi
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
log "=== support-agent run started (dry-run=$DRY_RUN, label-only=$LABEL_ONLY, auto-classify=$AUTO_CLASSIFY, comment-sync=$COMMENT_SYNC, state-sync=$STATE_SYNC, phase=$PHASE, fixture=${FIXTURE:-none}) ==="

# auto-classify, comment-sync, and state-sync each invoke Claude per work unit.
if [[ "$AUTO_CLASSIFY" -eq 1 || "$COMMENT_SYNC" -eq 1 || "$STATE_SYNC" -eq 1 ]] \
    && ! command -v claude >/dev/null 2>&1; then
  log "ERROR: --auto-classify / --comment-sync / --state-sync require the claude CLI on PATH (looked in: \$PATH=$PATH)"
  exit 1
fi
# comment-sync and state-sync also need gh on PATH (already required by the
# failure-issue trap, but it's worth a clean upfront error message rather than
# discovering it inside the per-issue loop).
if [[ "$COMMENT_SYNC" -eq 1 || "$STATE_SYNC" -eq 1 ]] && ! command -v gh >/dev/null 2>&1; then
  log "ERROR: --comment-sync / --state-sync require the gh CLI on PATH"
  exit 1
fi

# ── --comment-sync sweep ────────────────────────────────────────────────────
# Iterates GitHub support issues (NOT Zoho list-pending). The two flows are
# orthogonal so they don't share the per-thread loop below; run --auto-classify
# and --comment-sync as separate launchd jobs (or back-to-back from a wrapper).
if [[ "$COMMENT_SYNC" -eq 1 ]]; then
  PROMPT_FILE="$SCRIPT_DIR/support-agent-prompt.md"
  if [[ ! -f "$PROMPT_FILE" ]]; then
    log "ERROR: prompt file missing: $PROMPT_FILE"
    exit 1
  fi
  PROMPT_TEXT=$(cat "$PROMPT_FILE")

  if ! ISSUES_JSON=$(node "$SCRIPT_DIR/lib/github-sync.mjs" list-support-issues --state all 2>>"$LOG_FILE"); then
    log "ERROR: github-sync list-support-issues failed"
    exit 1
  fi
  ISSUE_COUNT=$(echo "$ISSUES_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$ISSUE_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric ISSUE_COUNT='$ISSUE_COUNT' (jq output malformed?)"
    exit 1
  fi
  log "Found $ISSUE_COUNT support-labelled issues"

  for IDX in $(seq 0 $((ISSUE_COUNT - 1))); do
    ISSUE_ENTRY=$(echo "$ISSUES_JSON" | jq ".[${IDX}]")
    ISSUE_NUMBER=$(echo "$ISSUE_ENTRY" | jq -r '.number')
    ISSUE_BODY=$(echo "$ISSUE_ENTRY" | jq -r '.body // ""')

    # Find the linked Zoho thread via the issue body's agent footer. If the
    # issue lacks the footer (e.g. an older Apps-Script-era issue) we have
    # no way to reach the customer — skip silently. This is correct: those
    # threads are decommissioned in Phase H anyway.
    THREAD_ID=$(printf '%s' "$ISSUE_BODY" | node "$SCRIPT_DIR/lib/parse-issue-footer.mjs" --field zoho-thread-id 2>>"$LOG_FILE" || echo "")
    if [[ -z "$THREAD_ID" ]]; then
      continue
    fi

    # Per-issue cursor; default to issue.createdAt so the first sync skips
    # comments that pre-existed when this PR landed (otherwise we'd forward
    # historical bot chatter as if it were new).
    CURSOR=""
    if [[ -f "$STATE_FILE" ]]; then
      CURSOR=$(jq -r --arg n "$ISSUE_NUMBER" '.issues[$n].lastGithubCommentSyncAt // empty' "$STATE_FILE" 2>/dev/null || echo "")
    fi
    if [[ -z "$CURSOR" ]]; then
      CURSOR=$(echo "$ISSUE_ENTRY" | jq -r '.createdAt')
    fi

    if ! NEW_COMMENTS=$(node "$SCRIPT_DIR/lib/github-sync.mjs" list-new-comments "$ISSUE_NUMBER" \
        --since "$CURSOR" --bot-user "$SUPPORT_BOT_GH_USER" 2>>"$LOG_FILE"); then
      log "WARNING: github-sync list-new-comments failed for issue #$ISSUE_NUMBER"
      continue
    fi
    NEW_COUNT=$(echo "$NEW_COMMENTS" | jq 'length' 2>/dev/null || echo "0")
    if ! [[ "$NEW_COUNT" =~ ^[0-9]+$ ]]; then
      log "WARNING: unexpected non-numeric NEW_COUNT='$NEW_COUNT' for issue #$ISSUE_NUMBER; skipping"
      continue
    fi
    if [[ "$NEW_COUNT" -eq 0 ]]; then
      continue
    fi
    log "Issue #$ISSUE_NUMBER: $NEW_COUNT new comment(s) since $CURSOR (thread=$THREAD_ID)"

    BUILD_INPUT=$(jq -n \
      --argjson issue "$ISSUE_ENTRY" \
      --argjson comments "$NEW_COMMENTS" \
      --arg threadId "$THREAD_ID" \
      '{
         kind: "github_comment_batch",
         issue: { number: $issue.number, title: $issue.title, state: $issue.state },
         comments: $comments,
         zohoThreadId: $threadId
       }')
    if ! BUNDLE=$(echo "$BUILD_INPUT" | node "$SCRIPT_DIR/lib/build-bundle.mjs" 2>>"$LOG_FILE"); then
      log "ERROR: build-bundle (github_comment_batch) failed for issue #$ISSUE_NUMBER"
      continue
    fi

    CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
      "$PROMPT_TEXT" "$BUNDLE")
    log "Invoking claude for issue #$ISSUE_NUMBER (comment-sync, phase=$PHASE)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t support-agent-out.XXXXXX)
    if ! claude -p "$CLAUDE_INPUT" --dangerously-skip-permissions \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE"; then
      log "ERROR: claude exited non-zero for issue #$ISSUE_NUMBER comment-sync"
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
      rm -f "$CLAUDE_OUTPUT_FILE"
      continue
    fi
    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
    SUMMARY_LINE=$(grep -E '^thread=[^ ]+ action=[^ ]+ issue=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
    rm -f "$CLAUDE_OUTPUT_FILE"
    if [[ -z "$SUMMARY_LINE" ]]; then
      log "WARNING: no well-formed summary line returned by claude for issue #$ISSUE_NUMBER comment-sync"
      continue
    fi
    log "Claude summary: $SUMMARY_LINE"
    ACTION=$(echo "$SUMMARY_LINE" | sed -E 's/.*action=([^ ]+).*/\1/')

    if [[ "$ACTION" == "sync-comment" ]]; then
      # Advance the cursor to the most recent comment's createdAt — that's
      # what bounds the next run's --since. Prefer ISO `created_at` (gh api
      # raw shape); fall back to camelCase for symmetry with our normalisers.
      LATEST=$(echo "$NEW_COMMENTS" | jq -r 'map(.created_at // .createdAt) | max' 2>/dev/null || echo "")
      if [[ -z "$LATEST" || "$LATEST" == "null" ]]; then
        log "WARNING: could not derive cursor for issue #$ISSUE_NUMBER (no created_at on new comments)"
      elif ! node "$SCRIPT_DIR/lib/state-cli.mjs" set-issue-cursor "$ISSUE_NUMBER" "$LATEST" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
        log "WARNING: state-cli set-issue-cursor failed for issue #$ISSUE_NUMBER"
      fi
    elif [[ "$ACTION" == "noop" ]]; then
      : # Claude saw nothing to forward (e.g. all comments turned out to be
        # bot-authored after re-checking) — leave the cursor untouched so we
        # retry on the next run.
    else
      log "WARNING: unexpected action '$ACTION' from claude for issue #$ISSUE_NUMBER comment-sync"
    fi
  done

  log "=== support-agent comment-sync completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
fi

# ── --state-sync sweep ──────────────────────────────────────────────────────
# Iterates GitHub support issues. For each, compares current state +
# stateReason against state.issues[<n>].lastKnownState. Bootstrap (no prior
# state) records current state silently; transitions build a
# github_state_change bundle and Claude composes the customer-facing email.
if [[ "$STATE_SYNC" -eq 1 ]]; then
  PROMPT_FILE="$SCRIPT_DIR/support-agent-prompt.md"
  if [[ ! -f "$PROMPT_FILE" ]]; then
    log "ERROR: prompt file missing: $PROMPT_FILE"
    exit 1
  fi
  PROMPT_TEXT=$(cat "$PROMPT_FILE")

  if ! ISSUES_JSON=$(node "$SCRIPT_DIR/lib/github-sync.mjs" list-support-issues --state all 2>>"$LOG_FILE"); then
    log "ERROR: github-sync list-support-issues failed"
    exit 1
  fi
  ISSUE_COUNT=$(echo "$ISSUES_JSON" | jq 'length' 2>/dev/null || echo "0")
  if ! [[ "$ISSUE_COUNT" =~ ^[0-9]+$ ]]; then
    log "ERROR: unexpected non-numeric ISSUE_COUNT='$ISSUE_COUNT' (jq output malformed?)"
    exit 1
  fi
  log "State-sync: found $ISSUE_COUNT support-labelled issues"

  for IDX in $(seq 0 $((ISSUE_COUNT - 1))); do
    ISSUE_ENTRY=$(echo "$ISSUES_JSON" | jq ".[${IDX}]")
    ISSUE_NUMBER=$(echo "$ISSUE_ENTRY" | jq -r '.number')
    NEW_STATE=$(echo "$ISSUE_ENTRY" | jq -r '.state // empty' | tr '[:upper:]' '[:lower:]')
    NEW_REASON=$(echo "$ISSUE_ENTRY" | jq -r '.stateReason // empty' | tr '[:upper:]' '[:lower:]')
    if [[ "$NEW_REASON" == "null" ]]; then
      NEW_REASON=""
    fi
    if [[ -z "$NEW_STATE" ]]; then
      log "WARNING: issue #$ISSUE_NUMBER has no .state field; skipping"
      continue
    fi

    # Look up the persisted lastKnownState. Missing → bootstrap.
    OLD_STATE=""
    OLD_REASON=""
    if [[ -f "$STATE_FILE" ]]; then
      OLD_STATE=$(jq -r --arg n "$ISSUE_NUMBER" \
        '.issues[$n].lastKnownState.state // empty' "$STATE_FILE" 2>/dev/null || echo "")
      OLD_REASON=$(jq -r --arg n "$ISSUE_NUMBER" \
        '.issues[$n].lastKnownState.state_reason // empty' "$STATE_FILE" 2>/dev/null || echo "")
      if [[ "$OLD_REASON" == "null" ]]; then
        OLD_REASON=""
      fi
    fi

    if [[ -z "$OLD_STATE" ]]; then
      log "State-sync: bootstrapping issue #$ISSUE_NUMBER (state=$NEW_STATE,reason=${NEW_REASON:-null})"
      if ! node "$SCRIPT_DIR/lib/state-cli.mjs" set-issue-state "$ISSUE_NUMBER" \
          "$NEW_STATE" "$NEW_REASON" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
        log "WARNING: set-issue-state (bootstrap) failed for issue #$ISSUE_NUMBER"
      fi
      continue
    fi

    if [[ "$NEW_STATE" == "$OLD_STATE" && "$NEW_REASON" == "$OLD_REASON" ]]; then
      continue
    fi

    log "State-sync: issue #$ISSUE_NUMBER transitioned ${OLD_STATE}/${OLD_REASON:-null} → ${NEW_STATE}/${NEW_REASON:-null}"

    if ! INFO=$(node "$SCRIPT_DIR/lib/github-sync.mjs" state-change-info "$ISSUE_NUMBER" \
        --bot-user "$SUPPORT_BOT_GH_USER" 2>>"$LOG_FILE"); then
      log "WARNING: state-change-info failed for issue #$ISSUE_NUMBER"
      continue
    fi
    THREAD_ID=$(echo "$INFO" | jq -r '.zoho_thread_id // empty')
    if [[ -z "$THREAD_ID" ]]; then
      # No linked Zoho thread — nothing to email. Still advance lastKnownState
      # so we don't re-detect the same transition every 5 minutes.
      log "State-sync: issue #$ISSUE_NUMBER has no zoho-thread-id footer; recording new state without notifying"
      if ! node "$SCRIPT_DIR/lib/state-cli.mjs" set-issue-state "$ISSUE_NUMBER" \
          "$NEW_STATE" "$NEW_REASON" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
        log "WARNING: set-issue-state failed for issue #$ISSUE_NUMBER"
      fi
      continue
    fi

    BUILD_INPUT=$(jq -n \
      --argjson issue "$ISSUE_ENTRY" \
      --arg oldState "$OLD_STATE" \
      --arg oldReason "$OLD_REASON" \
      --arg newState "$NEW_STATE" \
      --arg newReason "$NEW_REASON" \
      --argjson info "$INFO" \
      '{
         kind: "github_state_change",
         issue: { number: $issue.number, title: $issue.title },
         oldState: { state: $oldState, state_reason: (if $oldReason == "" then null else $oldReason end) },
         newState: { state: $newState, state_reason: (if $newReason == "" then null else $newReason end) },
         lastComment: $info.lastComment,
         platforms: $info.platforms,
         zohoThreadId: $info.zoho_thread_id
       }')
    if ! BUNDLE=$(echo "$BUILD_INPUT" | node "$SCRIPT_DIR/lib/build-bundle.mjs" 2>>"$LOG_FILE"); then
      log "ERROR: build-bundle (github_state_change) failed for issue #$ISSUE_NUMBER"
      continue
    fi

    CLAUDE_INPUT=$(printf '%s\n\n## Context bundle for this run\n\n```json\n%s\n```\n' \
      "$PROMPT_TEXT" "$BUNDLE")
    log "Invoking claude for issue #$ISSUE_NUMBER (state-sync, phase=$PHASE)"
    CLAUDE_OUTPUT_FILE=$(mktemp -t support-agent-out.XXXXXX)
    if ! claude -p "$CLAUDE_INPUT" --dangerously-skip-permissions \
        >"$CLAUDE_OUTPUT_FILE" 2>>"$LOG_FILE"; then
      log "ERROR: claude exited non-zero for issue #$ISSUE_NUMBER state-sync"
      cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE" 2>/dev/null || true
      rm -f "$CLAUDE_OUTPUT_FILE"
      continue
    fi
    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"
    SUMMARY_LINE=$(grep -E '^thread=[^ ]+ action=[^ ]+ issue=[^ ]+$' "$CLAUDE_OUTPUT_FILE" | tail -1 || true)
    rm -f "$CLAUDE_OUTPUT_FILE"
    if [[ -z "$SUMMARY_LINE" ]]; then
      log "WARNING: no summary line returned by claude for issue #$ISSUE_NUMBER state-sync"
      continue
    fi
    log "Claude summary: $SUMMARY_LINE"
    ACTION=$(echo "$SUMMARY_LINE" | sed -E 's/.*action=([^ ]+).*/\1/')

    case "$ACTION" in
      sync-state|noop)
        # Advance the cursor on both sync-state (email sent) and noop
        # (Claude classified the transition as one we don't act on, e.g.
        # open → open with a stale stateReason rewrite). Either way the
        # transition is "handled" — leaving it would re-fire forever.
        if ! node "$SCRIPT_DIR/lib/state-cli.mjs" set-issue-state "$ISSUE_NUMBER" \
            "$NEW_STATE" "$NEW_REASON" \
            --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
          log "WARNING: set-issue-state failed for issue #$ISSUE_NUMBER"
        fi
        ;;
      *)
        log "WARNING: unexpected action '$ACTION' for issue #$ISSUE_NUMBER state-sync; not advancing cursor"
        ;;
    esac
  done

  log "=== support-agent state-sync completed in $(( $(date +%s) - START_TIME ))s ==="
  exit 0
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
  SENDER=$(echo "$ENTRY" | jq -r '.fromAddress // .sender // empty')
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

  # Phase F linked-thread detection: if any message in the thread carries a
  # Drafto/Support/Issue/<n> label, the customer is replying on a
  # conversation we've already filed. Pre-fetch once here so the prompt's
  # step 4.5 can branch deterministically. Singletons (no threadId) are
  # never linked (they're definitionally first contact).
  LINKED_ISSUE=""
  if [[ -n "$THREAD_ID" && -z "$FIXTURE" && "$PHASE" =~ ^[FG]$ ]]; then
    if ! LINKED_ISSUE=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" find-linked-issue "$THREAD_ID" \
        2>>"$LOG_FILE"); then
      log "WARNING: find-linked-issue failed for $TRACK_ID; treating as unlinked"
      LINKED_ISSUE=""
    fi
  fi

  # Attachment fetch (Phase F+ only). Download every attachment on the
  # latest message to a per-thread tmpdir so the prompt's step 8.0 can
  # upload them when classifying as bug/feature. We always download
  # regardless of intent because bash doesn't know what Claude will
  # classify; unused files get reaped by the EXIT trap. Failures here
  # never block filing — issue without attachments is strictly better
  # than no filing.
  ATTACHMENTS_JSON='[]'
  if [[ -z "$FIXTURE" && -n "$MSG_ID" && -n "$FOLDER_ID" && "$PHASE" =~ ^[FG]$ ]]; then
    if INFO_JSON=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" get-attachment-info \
        "$FOLDER_ID" "$MSG_ID" 2>>"$LOG_FILE"); then
      INFO_COUNT=$(echo "$INFO_JSON" | jq 'length' 2>/dev/null || echo "0")
      if ! [[ "$INFO_COUNT" =~ ^[0-9]+$ ]]; then INFO_COUNT=0; fi
      if [[ "$INFO_COUNT" -gt 0 ]]; then
        # One tmp subdir per message (TRACK_ID may be a threadId or messageId).
        # Sanitise to be safe — TRACK_ID comes from Zoho's API so it's almost
        # certainly digits, but we don't want a stray slash to escape.
        SAFE_TRACK=$(printf '%s' "$TRACK_ID" | tr -c 'A-Za-z0-9._-' '_')
        MSG_TMP_DIR="$ATTACHMENTS_TMP_DIR/$SAFE_TRACK"
        mkdir -p "$MSG_TMP_DIR"
        DOWNLOADED_JSON='[]'
        # 25 MB applies to BOTH the per-file size and the cumulative-per-thread
        # total. Tracking only per-file would let a thread with five 6 MB
        # attachments slip past, then base64-expand to ~40 MB during step 8.0
        # uploads (1.33x blowup) and risk OOMs in Node's heap when the prompt
        # builds the upload payload.
        ATT_TOTAL_BYTES=0
        ATT_BUDGET=26214400
        for AIDX in $(seq 0 $((INFO_COUNT - 1))); do
          ATT=$(echo "$INFO_JSON" | jq ".[${AIDX}]")
          ATT_ID=$(echo "$ATT" | jq -r '.attachmentId')
          ATT_NAME=$(echo "$ATT" | jq -r '.filename // ("attachment-" + (.attachmentId|tostring))')
          ATT_SIZE=$(echo "$ATT" | jq -r '.size // 0')
          ATT_INLINE=$(echo "$ATT" | jq -r '.isInline // false')
          # Per-file cap — same as the per-run budget, since one file at the
          # cap is allowed but anything over is rejected outright.
          if [[ "$ATT_SIZE" =~ ^[0-9]+$ && "$ATT_SIZE" -gt "$ATT_BUDGET" ]]; then
            log "WARNING: skipping oversized attachment ($ATT_SIZE B) for $TRACK_ID: $ATT_NAME"
            continue
          fi
          # Per-run cumulative budget — stop downloading further attachments
          # once the next file would push the total over the cap. We `break`
          # rather than `continue` because attachments are typically returned
          # smallest-first by Zoho, but even when that's not the case, bailing
          # protects the host from an unbounded base64 expansion.
          if [[ "$ATT_SIZE" =~ ^[0-9]+$ ]] \
              && [[ $((ATT_TOTAL_BYTES + ATT_SIZE)) -gt "$ATT_BUDGET" ]]; then
            log "WARNING: per-run attachment budget ($ATT_BUDGET B) exhausted for $TRACK_ID; skipping $ATT_NAME and any later files"
            break
          fi
          # Sanitise filename for the tmpfile: same regex Apps Script uses
          # (a-z, A-Z, 0-9, dot, underscore, hyphen). Length-cap at 100 chars
          # so a pathological filename can't bust PATH_MAX. The full original
          # filename (UTF-8 etc.) is still preserved in the JSON metadata for
          # the prompt to use when picking the GitHub repo path.
          SAFE_NAME=$(printf '%s' "$ATT_NAME" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-100)
          if [[ -z "$SAFE_NAME" ]]; then SAFE_NAME="attachment-${AIDX}"; fi
          LOCAL_PATH="$MSG_TMP_DIR/${AIDX}-${SAFE_NAME}"
          if DL_JSON=$(node "$SCRIPT_DIR/lib/zoho-cli.mjs" download-attachment \
              "$FOLDER_ID" "$MSG_ID" "$ATT_ID" --out "$LOCAL_PATH" 2>>"$LOG_FILE"); then
            # download-attachment returns {filename, size, contentType, path};
            # contentType comes from the Zoho response header (attachmentinfo
            # doesn't include it). Merge with the original filename.
            DL_CT=$(echo "$DL_JSON" | jq -r '.contentType // "application/octet-stream"')
            DL_SIZE=$(echo "$DL_JSON" | jq -r '.size // 0')
            DOWNLOADED_JSON=$(echo "$DOWNLOADED_JSON" | jq \
              --arg filename "$ATT_NAME" \
              --arg contentType "$DL_CT" \
              --argjson size "$DL_SIZE" \
              --arg localPath "$LOCAL_PATH" \
              --argjson isInline "$ATT_INLINE" \
              '. + [{filename: $filename, contentType: $contentType, size: $size, localPath: $localPath, isInline: $isInline}]')
            # Bump the cumulative budget tracker using the actual downloaded
            # size (Zoho's attachmentinfo size is occasionally a few bytes off
            # for inline parts after MIME unwrapping).
            if [[ "$DL_SIZE" =~ ^[0-9]+$ ]]; then
              ATT_TOTAL_BYTES=$((ATT_TOTAL_BYTES + DL_SIZE))
            fi
          else
            log "WARNING: download-attachment failed for $TRACK_ID/$ATT_NAME — continuing without it"
          fi
        done
        ATTACHMENTS_JSON="$DOWNLOADED_JSON"
        DOWNLOADED_COUNT=$(echo "$ATTACHMENTS_JSON" | jq 'length' 2>/dev/null || echo "0")
        log "Downloaded $DOWNLOADED_COUNT/$INFO_COUNT attachment(s) for $TRACK_ID"
      fi
    else
      log "WARNING: get-attachment-info failed for $TRACK_ID (folder=$FOLDER_ID, msg=$MSG_ID); proceeding with no attachments"
    fi
  fi

  # build-bundle.mjs takes one combined JSON on stdin. Keeps the bundle
  # construction in Node where the policy.mjs functions live, instead of
  # duplicating the logic in `jq -n`.
  BUILD_INPUT=$(jq -n \
    --argjson pending "$ENTRY" \
    --argjson thread "$THREAD_JSON" \
    --argjson headers "$HEADERS_JSON" \
    --argjson state "$STATE_JSON" \
    --argjson attachments "$ATTACHMENTS_JSON" \
    --arg allowlist "$SUPPORT_ALLOWLIST" \
    --arg adminEmail "$ADMIN_EMAIL" \
    --arg oauthUserEmail "$OAUTH_USER_EMAIL" \
    --arg phase "$PHASE" \
    --arg linkedIssue "$LINKED_ISSUE" \
    '{
       pending: $pending,
       thread: $thread,
       headers: $headers,
       state: $state,
       linkedIssue: $linkedIssue,
       attachments: $attachments,
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
      # Phase E+: bump rate-limit counters so the next run respects the
      # ≤3-per-thread / ≤5-per-sender / ≤100-per-day caps. Sender comes from
      # the list-pending entry's fromAddress (the latest message in the
      # thread). If sender resolution failed, log a warning and skip the bump
      # — the thread cap still works because TRACK_ID alone covers it.
      if [[ -z "$SENDER" ]]; then
        log "WARNING: no sender address for $TRACK_ID; skipping bump-counters"
      elif ! node "$SCRIPT_DIR/lib/state-cli.mjs" bump-counters "$TRACK_ID" "$SENDER" \
          --state-file "$STATE_FILE" >>"$LOG_FILE" 2>&1; then
        log "WARNING: state-cli bump-counters failed for $TRACK_ID"
      fi
      ;;
    filed-issue)
      if [[ "$PHASE" =~ ^[DE]$ ]]; then
        log "ERROR: claude returned filed-issue under Phase $PHASE for $TRACK_ID — prompt phase gate violated"
        exit 1
      fi
      # Phase F+: Claude has already created the GitHub issue (with the
      # agent footer), replied to the customer in-thread, applied the
      # Drafto/Support/Issue/<n> label, and moved the thread to
      # Drafto/Support/Resolved. The bash side has nothing to bump — rate
      # caps don't apply to filings (we want every legitimate report to
      # produce an issue), and the linkage lives in the issue body footer
      # rather than support-state.json.
      ;;
    customer-reply)
      if [[ "$PHASE" =~ ^[DE]$ ]]; then
        log "ERROR: claude returned customer-reply under Phase $PHASE for $TRACK_ID — prompt phase gate violated"
        exit 1
      fi
      # Phase F+: Claude detected a customer reply on a thread linked to a
      # filed issue (Drafto/Support/Issue/<n> label found on some message in
      # the thread), commented on the GH issue with the customer's text, and
      # labelled the new message so list-pending stops surfacing it. No
      # bash-side state mutations — the cursor + footer linkage are
      # sufficient on their own.
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
