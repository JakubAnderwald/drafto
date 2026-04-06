#!/bin/bash
set -euo pipefail

# Ensure ~/.local/bin is in PATH (gh CLI location; launchd has minimal PATH)
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
umask 077
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/audit-$(date +%Y-%m-%d).log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
find "$LOG_DIR" -type f -name 'audit-*.log' -mtime +30 -delete 2>/dev/null || true

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

REPO="JakubAnderwald/drafto"
PROBLEMS=()
TODAY=$(date +%Y-%m-%d)

# ── Cleanup trap ──
cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    log "ERROR: Audit script exiting with code $exit_code"
    if command -v gh &>/dev/null; then
      gh issue create --repo "$REPO" \
        --title "Nightly audit script failed ($TODAY)" \
        --label "nightly-audit" \
        --body "The audit script itself exited with code \`$exit_code\`. Check \`logs/audit-$TODAY.log\` on the local machine." \
        2>/dev/null || log "WARNING: Failed to create failure issue"
    fi
  fi
}
trap cleanup EXIT

log "=== Nightly audit started ==="

# 24-hours-ago timestamp for filtering (macOS date -v)
YESTERDAY=$(date -v-24H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)

# ── Section A: Stage 1 — Issue Creation Health ──
log "--- Section A: Issue Creation Health ---"

SUPPORT_ISSUES=$(gh issue list --repo "$REPO" --label support --state all \
  --json number,title,body,createdAt --limit 100 2>/dev/null) || SUPPORT_ISSUES="[]"

RECENT_ISSUES=$(echo "$SUPPORT_ISSUES" | jq --arg since "$YESTERDAY" \
  '[.[] | select(.createdAt >= $since)]')
RECENT_COUNT=$(echo "$RECENT_ISSUES" | jq 'length')
log "Support issues created in last 24h: $RECENT_COUNT"

# Check for attachment failures
FAILED_UPLOADS=$(echo "$RECENT_ISSUES" | jq '[.[] | select(.body | test("Failed to upload|Failed to process"))]')
FAILED_COUNT=$(echo "$FAILED_UPLOADS" | jq 'length')
if [[ "$FAILED_COUNT" -gt 0 ]]; then
  ISSUE_NUMS=$(echo "$FAILED_UPLOADS" | jq -r '[.[].number | tostring] | join(", #")')
  PROBLEMS+=("### Stage 1: Attachment upload failures\n\n$FAILED_COUNT issue(s) have attachment failures: #$ISSUE_NUMS")
  log "WARNING: $FAILED_COUNT issues with attachment failures"
fi

# Check for needs-triage (unrecognized sender)
TRIAGE_ISSUES=$(gh issue list --repo "$REPO" --label needs-triage --state open \
  --json number,title --limit 50 2>/dev/null) || TRIAGE_ISSUES="[]"
TRIAGE_COUNT=$(echo "$TRIAGE_ISSUES" | jq 'length')
if [[ "$TRIAGE_COUNT" -gt 0 ]]; then
  TRIAGE_NUMS=$(echo "$TRIAGE_ISSUES" | jq -r '[.[].number | tostring] | join(", #")')
  PROBLEMS+=("### Stage 1: Issues needing triage\n\n$TRIAGE_COUNT open issue(s) with \`needs-triage\`: #$TRIAGE_NUMS")
  log "WARNING: $TRIAGE_COUNT issues need triage"
fi

# ── Section B: Stage 2 — Nightly Script Results ──
log "--- Section B: Nightly Script Results ---"

NIGHTLY_LOG="$LOG_DIR/nightly-$TODAY.log"
if [[ ! -f "$NIGHTLY_LOG" ]]; then
  PROBLEMS+=("### Stage 2: No nightly log\n\nExpected \`logs/nightly-$TODAY.log\` not found. The nightly script may not have run.")
  log "WARNING: Nightly log not found"
else
  # Check for ERROR entries (only timestamped lines to avoid false positives from Claude output)
  ERROR_LINES=$(grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\].*ERROR' "$NIGHTLY_LOG" 2>/dev/null || true)
  if [[ -n "$ERROR_LINES" ]]; then
    ERROR_COUNT=$(echo "$ERROR_LINES" | wc -l | tr -d ' ')
    PROBLEMS+=("### Stage 2: Errors in nightly log\n\n$ERROR_COUNT error(s) found:\n\n\`\`\`\n$ERROR_LINES\n\`\`\`")
    log "WARNING: $ERROR_COUNT errors in nightly log"
  fi

  # Check completion
  LAST_LINE=$(grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' "$NIGHTLY_LOG" 2>/dev/null | tail -1 || true)
  if [[ ! "$LAST_LINE" == *"completed"* ]]; then
    PROBLEMS+=("### Stage 2: Script may not have completed\n\nLast timestamped line:\n\`\`\`\n$LAST_LINE\n\`\`\`")
    log "WARNING: Nightly script may not have completed normally"
  fi
fi

# Check for needs-manual-intervention
MANUAL_ISSUES=$(gh issue list --repo "$REPO" --label needs-manual-intervention --state open \
  --json number,title --limit 50 2>/dev/null) || MANUAL_ISSUES="[]"
MANUAL_COUNT=$(echo "$MANUAL_ISSUES" | jq 'length')
if [[ "$MANUAL_COUNT" -gt 0 ]]; then
  MANUAL_LIST=$(echo "$MANUAL_ISSUES" | jq -r '.[] | "- #\(.number): \(.title)"')
  PROBLEMS+=("### Stage 2: Issues needing manual intervention\n\n$MANUAL_COUNT open issue(s):\n\n$MANUAL_LIST")
  log "WARNING: $MANUAL_COUNT issues need manual intervention"
fi

# ── Section C: PR / Merge Health ──
log "--- Section C: PR / Merge Health ---"

MERGED_PRS=$(gh pr list --repo "$REPO" --state merged --base main \
  --json number,title,mergedAt --limit 50 2>/dev/null) || MERGED_PRS="[]"
RECENT_MERGED=$(echo "$MERGED_PRS" | jq --arg since "$YESTERDAY" \
  '[.[] | select(.mergedAt >= $since)]')
MERGED_COUNT=$(echo "$RECENT_MERGED" | jq 'length')
log "PRs merged to main in last 24h: $MERGED_COUNT"

# Check main CI status after merges
if [[ "$MERGED_COUNT" -gt 0 ]]; then
  MAIN_STATUS=$(gh api "repos/$REPO/commits/main/status" --jq '.state' 2>/dev/null) || MAIN_STATUS="unknown"
  if [[ "$MAIN_STATUS" != "success" && "$MAIN_STATUS" != "pending" ]]; then
    PROBLEMS+=("### PR/Merge: Main branch CI is \`$MAIN_STATUS\`\n\nCI status on main after $MERGED_COUNT overnight merge(s).")
    log "WARNING: Main CI status is $MAIN_STATUS"
  else
    log "Main CI status: $MAIN_STATUS"
  fi
fi

# Open PRs from nightly bot with failing CI
OPEN_PRS=$(gh pr list --repo "$REPO" --state open --json number,title --limit 50 2>/dev/null) || OPEN_PRS="[]"
FAILING_BOT_PRS=()
for PR_NUM in $(echo "$OPEN_PRS" | jq -r '.[].number'); do
  # Check if any checks failed
  FAIL_COUNT=$(gh pr checks "$PR_NUM" --repo "$REPO" 2>/dev/null | grep -c "fail" || true)
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    # Check if nightly bot processed this PR
    COMMENTS=$(gh api --paginate "repos/$REPO/issues/$PR_NUM/comments" --jq '.[].body' 2>/dev/null || true)
    if echo "$COMMENTS" | grep -Fq '<!-- nightly-bot -->'; then
      PR_TITLE=$(echo "$OPEN_PRS" | jq -r ".[] | select(.number == $PR_NUM) | .title")
      FAILING_BOT_PRS+=("#$PR_NUM ($PR_TITLE)")
      log "WARNING: Bot-processed PR #$PR_NUM has failing CI"
    fi
  fi
done
if [[ ${#FAILING_BOT_PRS[@]} -gt 0 ]]; then
  PR_LIST=""
  for pr in "${FAILING_BOT_PRS[@]}"; do
    PR_LIST+="- $pr"$'\n'
  done
  PROBLEMS+=("### PR/Merge: Bot-processed PRs with failing CI\n\n$PR_LIST")
fi

# ── Section D: Build / Deploy Health ──
log "--- Section D: Build / Deploy Health ---"

if [[ -f "$NIGHTLY_LOG" ]]; then
  BUILD_FAILURES=$(grep -iE '(build failed|BUILD FAILED|Failed.*CocoaPods|Failed.*Gradle|gym returned exit code|error:.*signing)' "$NIGHTLY_LOG" 2>/dev/null | head -20 || true)
  if [[ -n "$BUILD_FAILURES" ]]; then
    PROBLEMS+=("### Build: Failures detected in nightly log\n\n\`\`\`\n$BUILD_FAILURES\n\`\`\`")
    log "WARNING: Build failures detected"
  fi

  # Check for iOS/Android build status comments
  IOS_FAILED=$(grep -c '| \*\*iOS\*\* | .*Failed' "$NIGHTLY_LOG" 2>/dev/null || true)
  ANDROID_FAILED=$(grep -c '| \*\*Android\*\* | .*Failed' "$NIGHTLY_LOG" 2>/dev/null || true)
  if [[ "$IOS_FAILED" -gt 0 || "$ANDROID_FAILED" -gt 0 ]]; then
    PROBLEMS+=("### Build: Platform build failures\n\n- iOS failures: $IOS_FAILED\n- Android failures: $ANDROID_FAILED")
    log "WARNING: Platform build failures (iOS: $IOS_FAILED, Android: $ANDROID_FAILED)"
  fi
fi

# ── Section E: App Health ──
log "--- Section E: App Health ---"

HTTP_CODE=$(curl -sL -o /dev/null -w '%{http_code}' --max-time 10 "https://drafto.eu" 2>/dev/null) || HTTP_CODE="000"
if [[ "$HTTP_CODE" != "200" ]]; then
  PROBLEMS+=("### App: drafto.eu health check failed\n\nHTTP status: \`$HTTP_CODE\` (expected 200)")
  log "WARNING: drafto.eu returned HTTP $HTTP_CODE"
else
  log "drafto.eu health check: OK (HTTP $HTTP_CODE)"
fi

# GitHub Actions CI on main
WORKFLOW_RUNS=$(gh run list --repo "$REPO" --branch main --limit 5 --json conclusion,name 2>/dev/null) || WORKFLOW_RUNS="[]"
FAILED_RUNS=$(echo "$WORKFLOW_RUNS" | jq '[.[] | select(.conclusion == "failure")]')
FAILED_RUN_COUNT=$(echo "$FAILED_RUNS" | jq 'length')
if [[ "$FAILED_RUN_COUNT" -gt 0 ]]; then
  FAILED_NAMES=$(echo "$FAILED_RUNS" | jq -r '[.[].name] | unique | join(", ")')
  PROBLEMS+=("### App: Failed CI workflows on main\n\nFailing: $FAILED_NAMES")
  log "WARNING: $FAILED_RUN_COUNT failed workflows on main"
else
  log "GitHub Actions on main: all passing"
fi

# ── Report ──
log "=== Audit complete ==="

if [[ ${#PROBLEMS[@]} -eq 0 ]]; then
  log "All checks passed. No issues to report."
  exit 0
fi

log "Found ${#PROBLEMS[@]} problem(s). Creating audit issue."

# Build issue body using heredoc for safe formatting
ISSUE_BODY="The nightly audit for **$TODAY** found the following problems:"
ISSUE_BODY+=$'\n\n'
for problem in "${PROBLEMS[@]}"; do
  ISSUE_BODY+="$(printf '%b' "$problem")"
  ISSUE_BODY+=$'\n\n'
done
ISSUE_BODY+="---"
ISSUE_BODY+=$'\n'
ISSUE_BODY+="*Generated by \`scripts/nightly-audit.sh\` — check \`logs/audit-$TODAY.log\` for details.*"

gh issue create --repo "$REPO" \
  --title "Nightly audit: problems found ($TODAY)" \
  --label "nightly-audit" \
  --body "$ISSUE_BODY"

log "Audit issue created."
