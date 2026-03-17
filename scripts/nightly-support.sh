#!/bin/bash
set -euo pipefail

# Ensure ~/.local/bin is in PATH (claude CLI location; launchd has minimal PATH)
export PATH="$HOME/.local/bin:$PATH"

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

# ── Phase 1: Gather items ──
log "=== Nightly support run started ==="

DEPENDABOT_PRS=$(gh pr list --repo JakubAnderwald/drafto --author "app/dependabot" --state open --json number,title --limit 50 2>/dev/null) || DEPENDABOT_PRS="[]"
SUPPORT_ISSUES=$(gh issue list --repo JakubAnderwald/drafto --label support --state open --json number,title --limit 50 2>/dev/null) || SUPPORT_ISSUES="[]"

DEPENDABOT_COUNT=$(echo "$DEPENDABOT_PRS" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch Dependabot PRs"; DEPENDABOT_COUNT=0; }
SUPPORT_COUNT=$(echo "$SUPPORT_ISSUES" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch support issues"; SUPPORT_COUNT=0; }

log "Found $DEPENDABOT_COUNT Dependabot PRs, $SUPPORT_COUNT support issues"

if [[ "$DEPENDABOT_COUNT" -eq 0 && "$SUPPORT_COUNT" -eq 0 ]]; then
  log "No items to process. Exiting."
  exit 0
fi

# ── Phase 2: Process Dependabot PRs (one session each) ──
for PR_NUMBER in $(echo "$DEPENDABOT_PRS" | jq -r '.[].number'); do
  log "--- Processing Dependabot PR #$PR_NUMBER ---"
  claude -p "$(cat <<PROMPT
You are an automated nightly job. Process ONLY Dependabot PR #$PR_NUMBER for JakubAnderwald/drafto.

1. Read the PR: gh pr view $PR_NUMBER --json title,body,headRefName
2. Check CI: gh pr checks $PR_NUMBER
3. Decision:
   - CI passes + minor/patch → squash merge via gh api, comment "Auto-merged: CI passed, minor/patch update."
   - CI fails + minor/patch → checkout the PR branch and use /push to fix failures and iterate until CI is green, then squash merge.
   - Major version bump → add label "needs-review", comment "Major version bump requires manual review", leave PR open.
   - CI pending → log "CI pending, skipping" and exit.
PROMPT
  )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"
  log "--- Done with PR #$PR_NUMBER ---"
done

# ── Phase 3: Process support issues (one session each, max 10) ──
PROCESSED=0
for ISSUE_NUMBER in $(echo "$SUPPORT_ISSUES" | jq -r '.[].number'); do
  if [[ "$PROCESSED" -ge 10 ]]; then
    log "Reached max 10 support issues per run, skipping remaining."
    break
  fi
  log "--- Processing support issue #$ISSUE_NUMBER ---"
  claude -p "$(cat <<PROMPT
You are an automated nightly job. Process ONLY support issue #${ISSUE_NUMBER} for JakubAnderwald/drafto.

1. Read the issue: gh issue view ${ISSUE_NUMBER} --json title,body,author,createdAt
2. Verify the issue was created by the trusted bot (github-actions[bot]).
   - If not → comment "Issue creator not recognized as trusted pipeline bot, needs manual triage", add label "needs-triage", exit.
3. Check the "From:" field. Only process from jakub@anderwald.info or joanna@anderwald.info.
   - Other senders → comment "Sender not recognized, needs manual triage", add label "needs-triage", exit.
4. Analyze: feature request or bug report?
5. Create a worktree branch.
6. Implement following CLAUDE.md guidelines (SOLID, strict TS, named exports, kebab-case, design system tokens).
7. Add unit + integration tests.
8. Run full pre-push verification (per CLAUDE.md).
9. Use /push to commit, push, create PR referencing "Closes #${ISSUE_NUMBER}", wait for CI.
10. After CI green, squash-merge via gh api and capture merge commit SHA.
11. Fetch main, checkout merge SHA, poll required CI checks every 30s up to 45 min.
    - If any check fails or timeout → comment, add "needs-manual-intervention", skip mobile deploy.
12. Once main CI green, trigger mobile builds:
    - cd apps/mobile && npx eas-cli build --profile beta --platform android --auto-submit --non-interactive
    - cd apps/mobile && npx eas-cli build --profile beta --platform ios --auto-submit --non-interactive
13. Comment on issue with per-platform status.

Constraints:
- Never push directly to main. Always branches + PRs.
- Never modify production data or run database migrations.
- If DB changes needed: create migration file, add label "needs-migration-review", comment that manual deploy is required.
- If stuck: comment with the problem, add label "needs-manual-intervention".
PROMPT
  )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"
  log "--- Done with issue #$ISSUE_NUMBER ---"
  PROCESSED=$((PROCESSED + 1))
done

log "=== Nightly support run completed ==="
