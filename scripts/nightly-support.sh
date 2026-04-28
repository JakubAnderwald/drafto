#!/bin/bash
set -euo pipefail

# Ensure ~/.local/bin is in PATH (claude CLI location; launchd has minimal PATH)
export PATH="$HOME/.local/bin:$PATH"

# Ensure UTF-8 locale for CocoaPods (launchd provides minimal C/POSIX locale)
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# Initialize rbenv so Fastlane uses the project Ruby (3.3.7), not system Ruby (2.6)
# rbenv may be in ~/.rbenv/bin (manual install) or /opt/homebrew/bin (Homebrew)
RBENV_BIN=""
if command -v rbenv &>/dev/null; then
  RBENV_BIN="$(command -v rbenv)"
elif [[ -x "$HOME/.rbenv/bin/rbenv" ]]; then
  RBENV_BIN="$HOME/.rbenv/bin/rbenv"
elif [[ -x "/opt/homebrew/bin/rbenv" ]]; then
  RBENV_BIN="/opt/homebrew/bin/rbenv"
fi

if [[ -n "$RBENV_BIN" ]]; then
  eval "$("$RBENV_BIN" init -)" || {
    echo "ERROR: rbenv init failed; aborting to avoid using system Ruby" >&2
    exit 1
  }
fi

# Load signing credentials for local Fastlane builds (Android keystore, ASC API key, Match password)
if [[ -f "$HOME/drafto-secrets/android-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/drafto-secrets/android-env.sh"
fi

# Load support pipeline allowlist (Phase F gate). Single source of truth used
# by scripts/support-agent.sh too — keep them in sync.
if [[ -f "$HOME/drafto-secrets/support-env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/drafto-secrets/support-env.sh"
fi
SUPPORT_ALLOWLIST="${SUPPORT_ALLOWLIST:-jakub@anderwald.info,joanna@anderwald.info}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
umask 077
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/nightly-$(date +%Y-%m-%d).log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
# Retain only recent logs to reduce sensitive-data exposure
find "$LOG_DIR" -type f -name 'nightly-*.log' -mtime +30 -delete 2>/dev/null || true

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
NIGHTLY_MARKER='<!-- nightly-bot -->'

# ── Failure notification ──
cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    log "ERROR: Script exiting with code $exit_code"
    # Extract only timestamped log lines (script's own output), stripping Claude/support content
    local sanitized_log
    sanitized_log=$(grep -E '^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\]' "$LOG_FILE" 2>/dev/null | tail -20 || echo "No log available")
    if command -v gh &>/dev/null; then
      # Upload full log as a secret gist so it's accessible from the issue
      local gist_url=""
      if [[ -s "$LOG_FILE" ]]; then
        gist_url=$(gh gist create --desc "Nightly script log $(date +%Y-%m-%d)" "$LOG_FILE" 2>/dev/null) || true
      fi
      local log_line
      if [[ -n "$gist_url" ]]; then
        log_line="**Full log**: $gist_url"
      else
        log_line="Full log (may contain sensitive content) is at \`logs/nightly-$(date +%Y-%m-%d).log\` on the local machine. (Gist upload failed.)"
      fi
      gh issue create \
        --repo JakubAnderwald/drafto \
        --title "Nightly script failed ($(date +%Y-%m-%d))" \
        --label "nightly-failure" \
        --body "$(cat <<EOF
The nightly script exited with code \`$exit_code\` on $(date '+%Y-%m-%d at %H:%M:%S').

### Script log (timestamped entries only)

\`\`\`
$sanitized_log
\`\`\`

$log_line
EOF
        )" 2>/dev/null || log "WARNING: Failed to create GitHub issue"
    else
      log "WARNING: gh CLI not available, cannot create failure issue"
    fi
  fi
}
trap cleanup EXIT

# ── Phase 1: Gather items ──
START_TIME=$(date +%s)
log "=== Nightly support run started ==="

DEPENDABOT_PRS=$(gh pr list --repo JakubAnderwald/drafto --author "app/dependabot" \
  --state open --json number,title,labels --limit 50 2>/dev/null) || DEPENDABOT_PRS="[]"
# Pull body + labels too: Phase F gate parses the support-agent footer in the
# body, and we filter out issues already marked needs-triage so we don't
# re-comment on rejected reporters every nightly run.
SUPPORT_ISSUES=$(gh issue list --repo JakubAnderwald/drafto --label support --state open --json number,title,body,labels --limit 50 2>/dev/null) || SUPPORT_ISSUES="[]"

# Skip Dependabot PRs already labeled needs-review (processed in a prior run)
DEPENDABOT_ALL_COUNT=$(echo "$DEPENDABOT_PRS" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch Dependabot PRs"; DEPENDABOT_ALL_COUNT=0; }
DEPENDABOT_PRS=$(echo "$DEPENDABOT_PRS" | \
  jq '[.[] | select(.labels | map(.name) | index("needs-review") | not)]') || DEPENDABOT_PRS="[]"
DEPENDABOT_COUNT=$(echo "$DEPENDABOT_PRS" | jq 'length') || DEPENDABOT_COUNT=0
# Skip support issues already triaged (Phase F gate added needs-triage on a
# prior run). Dependabot uses the same pattern with needs-review.
SUPPORT_ISSUES_ALL_COUNT=$(echo "$SUPPORT_ISSUES" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch support issues"; SUPPORT_ISSUES_ALL_COUNT=0; }
SUPPORT_ISSUES=$(echo "$SUPPORT_ISSUES" | \
  jq '[.[] | select(.labels | map(.name) | index("needs-triage") | not)]') || SUPPORT_ISSUES="[]"
SUPPORT_COUNT=$(echo "$SUPPORT_ISSUES" | jq 'length') || SUPPORT_COUNT=0
SUPPORT_TRIAGED_COUNT=$(( SUPPORT_ISSUES_ALL_COUNT - SUPPORT_COUNT ))

SKIPPED_COUNT=$(( DEPENDABOT_ALL_COUNT - DEPENDABOT_COUNT ))
log "Found $DEPENDABOT_ALL_COUNT Dependabot PRs ($SKIPPED_COUNT already labeled needs-review, $DEPENDABOT_COUNT to process), $SUPPORT_COUNT support issues ($SUPPORT_TRIAGED_COUNT already labeled needs-triage)"

if [[ "$DEPENDABOT_COUNT" -eq 0 && "$SUPPORT_COUNT" -eq 0 ]]; then
  log "No items to process."
  log "=== Nightly support run completed (no items) ==="
  exit 0
fi

# ── Phase 2: Process Dependabot PRs (one session each, 2h cap) ──
PHASE2_DEADLINE=$(( $(date +%s) + 7200 ))  # 2 hours max for all Dependabot PRs
for PR_NUMBER in $(echo "$DEPENDABOT_PRS" | jq -r '.[].number'); do
  REMAINING=$(( PHASE2_DEADLINE - $(date +%s) ))
  if [[ "$REMAINING" -le 0 ]]; then
    log "Phase 2 deadline reached, skipping remaining Dependabot PRs to process support queue."
    break
  fi
  POLL_TIMEOUT=$(( REMAINING < 900 ? REMAINING : 900 ))  # min(remaining, 15min) in seconds
  # Skip if already processed (comment marker from a prior run)
  if ! COMMENT_BODIES=$(gh api --paginate "repos/JakubAnderwald/drafto/issues/$PR_NUMBER/comments" \
    --jq '.[].body // empty' 2>/dev/null); then
    log "WARNING: Failed to fetch comments for PR #$PR_NUMBER; skipping to preserve idempotency."
    continue
  fi
  if grep -Fq "$NIGHTLY_MARKER" <<<"$COMMENT_BODIES"; then
    log "PR #$PR_NUMBER already has nightly-bot comment, skipping."
    continue
  fi
  log "--- Processing Dependabot PR #$PR_NUMBER (${REMAINING}s remaining, poll timeout ${POLL_TIMEOUT}s) ---"
  if ! claude -p "$(cat <<PROMPT
You are an automated nightly job. Process ONLY Dependabot PR #$PR_NUMBER for JakubAnderwald/drafto.

1. Read the PR: gh pr view $PR_NUMBER --json title,body,headRefName
2. Check CI: gh pr checks $PR_NUMBER
3. Decision:
   - CI passes + minor/patch → squash merge via gh api, comment "${NIGHTLY_MARKER}Auto-merged: CI passed, minor/patch update."
   - CI fails + minor/patch → checkout the PR branch and use /push to fix failures and iterate until CI is green, then squash merge.
   - CI pending → poll \`gh pr checks $PR_NUMBER\` every 30 seconds for up to $POLL_TIMEOUT seconds until all checks complete. Then apply the rules above (merge/fix/flag). If still pending after timeout, log "CI still pending after timeout, skipping" and exit.
   - Major version bump → analyse the impact before flagging:
     1. Read the PR body and changelog/release notes linked by Dependabot.
     2. Search the codebase for all imports and usages of the bumped package.
     3. Identify breaking changes from the changelog that affect this codebase.
     4. Check if the package's major bump requires peer dependency updates.
     5. Add label "needs-review" and comment (starting with "${NIGHTLY_MARKER}") with a structured report:
        - **Package**: name, old version → new version
        - **Breaking changes relevant to this codebase**: list each with affected files
        - **Breaking changes NOT relevant**: list briefly (features/APIs we don't use)
        - **Peer dependency impacts**: any cascading updates needed
        - **Recommendation**: "Safe to merge" / "Merge with changes" / "Skip this version" — with reasoning
        - **If "Merge with changes"**: list the specific code changes needed
     6. Leave PR open for manual review.
PROMPT
  )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"; then
    log "ERROR: Dependabot PR #$PR_NUMBER failed; continuing with next item"
  fi
  log "--- Done with PR #$PR_NUMBER ---"
done

# ── Phase 3: Process support issues (one session each, max 10) ──
PROCESSED=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for IDX in $(seq 0 $((SUPPORT_COUNT - 1))); do
  if [[ "$PROCESSED" -ge 10 ]]; then
    log "Reached max 10 support issues per run, skipping remaining."
    break
  fi
  ISSUE_ENTRY=$(echo "$SUPPORT_ISSUES" | jq ".[${IDX}]")
  ISSUE_NUMBER=$(echo "$ISSUE_ENTRY" | jq -r '.number')
  ISSUE_BODY=$(echo "$ISSUE_ENTRY" | jq -r '.body // ""')

  # ── Phase F gate: defence-in-depth allowlist check ──
  # Pre-gate before invoking Claude, so a non-allowlisted reporter doesn't
  # burn a full Claude session. The gate requires BOTH:
  #   (a) the agent footer claims `reporter-allowlisted: true`, AND
  #   (b) the footer's `reporter-email` is in $SUPPORT_ALLOWLIST.
  # A tampered issue body could smuggle (a) past us — (b) catches that.
  GATE=$(printf '%s' "$ISSUE_BODY" | node "$SCRIPT_DIR/lib/parse-issue-footer.mjs" \
      --check-allowlist --allowlist "$SUPPORT_ALLOWLIST" 2>/dev/null) || GATE="allowed=false reason=gate-error"
  if ! [[ "$GATE" =~ ^allowed=true ]]; then
    REASON=$(echo "$GATE" | sed -nE 's/.*reason=([^ ]+).*/\1/p')
    REASON="${REASON:-unknown}"
    log "Issue #$ISSUE_NUMBER: gate rejected (reason=$REASON); marking needs-triage"
    gh issue comment "$ISSUE_NUMBER" --repo JakubAnderwald/drafto \
      --body "Reporter not on the support allowlist (reason: ${REASON}). Needs manual triage." \
      2>/dev/null || log "WARNING: failed to comment on issue #$ISSUE_NUMBER"
    gh issue edit "$ISSUE_NUMBER" --repo JakubAnderwald/drafto \
      --add-label needs-triage \
      2>/dev/null || log "WARNING: failed to add needs-triage to issue #$ISSUE_NUMBER"
    continue
  fi

  log "--- Processing support issue #$ISSUE_NUMBER (gate passed) ---"
  if ! claude -p "$(cat <<PROMPT
You are an automated nightly job. Process ONLY support issue #${ISSUE_NUMBER} for JakubAnderwald/drafto.

The issue has already passed the support-agent footer gate (reporter is on \$SUPPORT_ALLOWLIST). Skip any From: / sender re-checks.

1. Read the issue: gh issue view ${ISSUE_NUMBER} --json title,body,author,createdAt
2. Verify the issue has the "support" label (applied by the Stage 1 ingest pipeline).
   - If the label is missing → comment "Issue missing support label, needs manual triage", add label "needs-triage", exit.
3. Analyze: feature request or bug report?
4. Create a worktree branch.
5. Implement following CLAUDE.md guidelines (SOLID, strict TS, named exports, kebab-case, design system tokens).
6. Add unit + integration tests.
7. Run full pre-push verification (per CLAUDE.md).
8. Use /push to commit, push, create PR referencing "Closes #${ISSUE_NUMBER}", wait for CI.
9. After CI green, squash-merge via gh api and capture merge commit SHA.
10. Fetch main, checkout merge SHA, poll required CI checks every 30s up to 45 min.
    - If any check fails or timeout → comment, add "needs-manual-intervention", skip mobile deploy.
11. Once main CI green, run local Fastlane builds (signing credentials are pre-loaded in the environment):
    - Android: cd apps/mobile && bundle install --quiet && bundle exec fastlane android beta
    - iOS: cd apps/mobile && bundle exec fastlane ios beta
    - Desktop (macOS): cd apps/desktop && bundle install --quiet && bundle exec fastlane beta
    - Run each build separately. If one fails, still attempt the others.
    - Important: run bundle install before Fastlane (worktrees do not share gems).
12. Comment on issue with per-platform build result (succeeded/failed with error summary for each of Android, iOS, and Desktop).

Constraints:
- Never push directly to main. Always branches + PRs.
- Never modify production data or run database migrations.
- If DB changes needed: create migration file, add label "needs-migration-review", comment that manual deploy is required.
- If stuck: comment with the problem, add label "needs-manual-intervention".
PROMPT
  )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"; then
    log "ERROR: Support issue #$ISSUE_NUMBER failed; continuing with next item"
  fi
  log "--- Done with issue #$ISSUE_NUMBER ---"
  PROCESSED=$((PROCESSED + 1))
done

# ── Phase 4: (No-op — local Fastlane builds are synchronous) ──
# Local builds run inline during Phase 3 Claude sessions. The session handles
# success/failure and comments on the issue directly. Nothing to poll.
log "=== Phase 4: Skipped (builds run locally in Phase 3) ==="

ELAPSED=$(( $(date +%s) - START_TIME ))
log "=== Nightly support run completed in ${ELAPSED}s ==="
