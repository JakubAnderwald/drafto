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

Full log (may contain sensitive content) is at \`logs/nightly-$(date +%Y-%m-%d).log\` on the local machine.
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
SUPPORT_ISSUES=$(gh issue list --repo JakubAnderwald/drafto --label support --state open --json number,title --limit 50 2>/dev/null) || SUPPORT_ISSUES="[]"

# Skip Dependabot PRs already labeled needs-review (processed in a prior run)
DEPENDABOT_ALL_COUNT=$(echo "$DEPENDABOT_PRS" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch Dependabot PRs"; DEPENDABOT_ALL_COUNT=0; }
DEPENDABOT_PRS=$(echo "$DEPENDABOT_PRS" | \
  jq '[.[] | select(.labels | map(.name) | index("needs-review") | not)]') || DEPENDABOT_PRS="[]"
DEPENDABOT_COUNT=$(echo "$DEPENDABOT_PRS" | jq 'length') || DEPENDABOT_COUNT=0
SUPPORT_COUNT=$(echo "$SUPPORT_ISSUES" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch support issues"; SUPPORT_COUNT=0; }

SKIPPED_COUNT=$(( DEPENDABOT_ALL_COUNT - DEPENDABOT_COUNT ))
log "Found $DEPENDABOT_ALL_COUNT Dependabot PRs ($SKIPPED_COUNT already labeled needs-review, $DEPENDABOT_COUNT to process), $SUPPORT_COUNT support issues"

if [[ "$DEPENDABOT_COUNT" -eq 0 && "$SUPPORT_COUNT" -eq 0 ]]; then
  log "No items to process. Exiting."
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
# Record the timestamp before Phase 3 so Phase 4 can find builds triggered during this phase.
PHASE3_START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PROCESSED=0
PHASE3_ISSUE_NUMBERS=()  # Track which issues were processed (for Phase 4 comments)
for ISSUE_NUMBER in $(echo "$SUPPORT_ISSUES" | jq -r '.[].number'); do
  if [[ "$PROCESSED" -ge 10 ]]; then
    log "Reached max 10 support issues per run, skipping remaining."
    break
  fi
  log "--- Processing support issue #$ISSUE_NUMBER ---"
  if ! claude -p "$(cat <<PROMPT
You are an automated nightly job. Process ONLY support issue #${ISSUE_NUMBER} for JakubAnderwald/drafto.

1. Read the issue: gh issue view ${ISSUE_NUMBER} --json title,body,author,createdAt
2. Verify the issue has the "support" label (applied by the Stage 1 ingest pipeline).
   - If the label is missing → comment "Issue missing support label, needs manual triage", add label "needs-triage", exit.
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
  )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"; then
    log "ERROR: Support issue #$ISSUE_NUMBER failed; continuing with next item"
  fi
  log "--- Done with issue #$ISSUE_NUMBER ---"
  PHASE3_ISSUE_NUMBERS+=("$ISSUE_NUMBER")
  PROCESSED=$((PROCESSED + 1))
done

# ── Phase 4: Monitor EAS builds and fix failures (up to 2 retries per build) ──
MAX_BUILD_RETRIES=2
BUILD_POLL_INTERVAL=60        # seconds between EAS status checks
BUILD_POLL_TIMEOUT=2700       # 45 min max wait per build round
PHASE4_DEADLINE=$(( $(date +%s) + 7200 ))  # 2h hard cap for entire Phase 4

log "=== Phase 4: Monitoring EAS builds (started after $PHASE3_START_ISO) ==="

# Collect EAS builds triggered during Phase 3 (filter by createdAt >= PHASE3_START_ISO)
get_pending_builds() {
  cd "$REPO_ROOT/apps/mobile"
  npx eas-cli build:list --limit 20 --json --non-interactive 2>/dev/null | \
    jq --arg since "$PHASE3_START_ISO" \
      '[.[] | select(.createdAt >= $since and (.status == "NEW" or .status == "IN_QUEUE" or .status == "IN_PROGRESS" or .status == "ERRORED" or .status == "FINISHED"))]'
  cd "$REPO_ROOT"
}

# Wait for all in-progress builds to reach a terminal state, return the JSON array
wait_for_builds() {
  local deadline=$(( $(date +%s) + BUILD_POLL_TIMEOUT ))
  while true; do
    local builds
    builds=$(get_pending_builds) || { log "WARNING: Failed to query EAS builds"; echo "[]"; return; }
    local in_progress
    in_progress=$(echo "$builds" | jq '[.[] | select(.status == "NEW" or .status == "IN_QUEUE" or .status == "IN_PROGRESS")] | length')
    if [[ "$in_progress" -eq 0 ]]; then
      echo "$builds"
      return
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      log "WARNING: Build poll timeout reached with $in_progress builds still in progress"
      echo "$builds"
      return
    fi
    log "Waiting for $in_progress EAS build(s) to complete..."
    sleep "$BUILD_POLL_INTERVAL"
  done
}

# Track retry counts per build platform (android/ios — lowercase to match EAS CLI JSON output)
declare -A PLATFORM_RETRIES
PLATFORM_RETRIES[android]=0
PLATFORM_RETRIES[ios]=0

ROUND=0
while true; do
  ROUND=$((ROUND + 1))

  # Hard deadline check
  if [[ $(date +%s) -ge $PHASE4_DEADLINE ]]; then
    log "Phase 4 hard deadline reached. Stopping build monitoring."
    break
  fi

  log "--- Build monitoring round $ROUND ---"
  BUILDS=$(wait_for_builds)
  TOTAL=$(echo "$BUILDS" | jq 'length')

  if [[ "$TOTAL" -eq 0 ]]; then
    log "No EAS builds found from this run. Skipping Phase 4."
    break
  fi

  ERRORED=$(echo "$BUILDS" | jq '[.[] | select(.status == "ERRORED")]')
  ERRORED_COUNT=$(echo "$ERRORED" | jq 'length')
  FINISHED_COUNT=$(echo "$BUILDS" | jq '[.[] | select(.status == "FINISHED")] | length')

  log "Build results: $FINISHED_COUNT succeeded, $ERRORED_COUNT failed (of $TOTAL total)"

  if [[ "$ERRORED_COUNT" -eq 0 ]]; then
    log "All EAS builds succeeded."
    break
  fi

  # Process each failed build
  NEEDS_ANOTHER_ROUND=false
  for BUILD_ROW in $(echo "$ERRORED" | jq -r '.[] | @base64'); do
    BUILD_JSON=$(echo "$BUILD_ROW" | base64 --decode)
    BUILD_ID=$(echo "$BUILD_JSON" | jq -r '.id')
    BUILD_PLATFORM=$(echo "$BUILD_JSON" | jq -r '.platform')
    BUILD_ERROR=$(echo "$BUILD_JSON" | jq -r '.error.message // "Unknown error"')
    BUILD_ERROR_CODE=$(echo "$BUILD_JSON" | jq -r '.error.errorCode // "UNKNOWN"')

    RETRIES=${PLATFORM_RETRIES[$BUILD_PLATFORM]:-0}
    if [[ "$RETRIES" -ge "$MAX_BUILD_RETRIES" ]]; then
      log "Platform $BUILD_PLATFORM: already retried $RETRIES times, skipping. Manual intervention needed."
      continue
    fi

    log "Platform $BUILD_PLATFORM build $BUILD_ID failed ($BUILD_ERROR_CODE): $BUILD_ERROR"
    log "Attempting fix (retry $((RETRIES + 1))/$MAX_BUILD_RETRIES)..."

    PLATFORM_LC=$(echo "$BUILD_PLATFORM" | tr '[:upper:]' '[:lower:]')
    if ! claude -p "$(cat <<PROMPT
You are an automated nightly job fixing a failed EAS mobile build for JakubAnderwald/drafto.

**Failed build details:**
- Platform: $BUILD_PLATFORM
- Build ID: $BUILD_ID
- Error code: $BUILD_ERROR_CODE
- Error message: $BUILD_ERROR

**Your task:**
1. Diagnose the build failure:
   - Fetch the build logs: cd apps/mobile && npx eas-cli build:view $BUILD_ID --json
   - If the error is a native build error (Gradle/Xcode), look at the error message and search the codebase for the affected code.
   - Common causes: missing native dependencies after adding an Expo package (need expo prebuild), incompatible native code, misconfigured build settings.

2. Fix the issue:
   - Create a worktree branch (e.g., fix/eas-${PLATFORM_LC}-build).
   - Make the minimal fix needed. Common fixes include:
     - Running \`npx expo prebuild --clean\` to regenerate native projects
     - Adding missing native dependencies or plugins to app.config.ts
     - Fixing native code compilation errors in android/ or ios/ directories
     - Updating EAS build profile settings in eas.json
   - Run local checks: pnpm lint && pnpm typecheck && cd apps/mobile && pnpm test
   - Use /push to commit, push, create PR, and wait for CI green.
   - Squash-merge via gh api.

3. Retrigger the build:
   - cd apps/mobile && npx eas-cli build --profile beta --platform $PLATFORM_LC --auto-submit --non-interactive

4. Comment on any related support issues (check recent closed issues with "support" label) with the fix status.

Constraints:
- Never push directly to main. Always branches + PRs.
- Never modify production data.
- If you cannot diagnose or fix the issue, comment on a new GitHub issue with the build error details and add label "needs-manual-intervention".
PROMPT
    )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"; then
      log "ERROR: Fix attempt for $BUILD_PLATFORM build failed"
    fi

    PLATFORM_RETRIES[$BUILD_PLATFORM]=$((RETRIES + 1))
    NEEDS_ANOTHER_ROUND=true
    log "--- Done with $BUILD_PLATFORM build fix attempt ---"
  done

  if [[ "$NEEDS_ANOTHER_ROUND" == false ]]; then
    log "No more builds to retry. Exiting Phase 4."
    break
  fi

  log "Retriggered builds — starting next monitoring round..."
done

# Final build status summary
FINAL_BUILDS=$(get_pending_builds 2>/dev/null) || FINAL_BUILDS="[]"
FINAL_ERRORED=$(echo "$FINAL_BUILDS" | jq '[.[] | select(.status == "ERRORED")] | length')
FINAL_FINISHED=$(echo "$FINAL_BUILDS" | jq '[.[] | select(.status == "FINISHED")] | length')
FINAL_PENDING=$(echo "$FINAL_BUILDS" | jq '[.[] | select(.status == "NEW" or .status == "IN_QUEUE" or .status == "IN_PROGRESS")] | length')
log "Phase 4 summary: $FINAL_FINISHED succeeded, $FINAL_ERRORED failed, $FINAL_PENDING still pending"

if [[ "$FINAL_ERRORED" -gt 0 ]]; then
  log "WARNING: Some builds still failing after retries. Manual intervention needed."
  # Comment only on support issues that were actually processed in Phase 3
  for ISSUE_NUMBER in "${PHASE3_ISSUE_NUMBERS[@]}"; do
    FAILED_PLATFORMS=$(echo "$FINAL_BUILDS" | jq -r '[.[] | select(.status == "ERRORED") | .platform] | join(", ")')
    gh issue comment "$ISSUE_NUMBER" --repo JakubAnderwald/drafto --body "${NIGHTLY_MARKER}
## Build monitoring update

After $ROUND round(s) of automated fix attempts, some mobile builds are still failing:
- **Failed platforms**: $FAILED_PLATFORMS
- **Retries exhausted**: $MAX_BUILD_RETRIES per platform

Manual intervention is required to resolve the remaining build issues.
" 2>/dev/null || log "WARNING: Failed to comment on issue #$ISSUE_NUMBER"
    gh issue edit "$ISSUE_NUMBER" --repo JakubAnderwald/drafto --add-label "needs-manual-intervention" 2>/dev/null || true
  done
fi

ELAPSED=$(( $(date +%s) - START_TIME ))
log "=== Nightly support run completed in ${ELAPSED}s ==="
