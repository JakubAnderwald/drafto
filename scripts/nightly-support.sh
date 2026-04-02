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
12. Once main CI green, trigger mobile builds via GitHub Actions:
    - gh workflow run beta-release.yml --repo JakubAnderwald/drafto -f platform=all
    - Sleep 5 seconds, then capture the run ID:
      gh run list --workflow=beta-release.yml --repo JakubAnderwald/drafto --limit 1 --json databaseId --jq '.[0].databaseId'
    - Comment on issue with the Actions run URL: https://github.com/JakubAnderwald/drafto/actions/runs/<RUN_ID>
13. Comment on issue with per-platform build trigger status.

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

# ── Phase 4: Monitor GitHub Actions builds and fix failures (up to 2 retries per platform) ──
MAX_BUILD_RETRIES=2
BUILD_POLL_INTERVAL=60        # seconds between workflow status checks
BUILD_POLL_TIMEOUT=2700       # 45 min max wait per monitoring round
PHASE4_DEADLINE=$(( $(date +%s) + 7200 ))  # 2h hard cap for entire Phase 4

log "=== Phase 4: Monitoring GitHub Actions builds (started after $PHASE3_START_ISO) ==="

GH_REPO="JakubAnderwald/drafto"
GH_WORKFLOW="beta-release.yml"

# Helper functions for platform retry tracking (bash 3.2 compatible)
get_platform_retries() {
  case "$1" in
    android) echo "$RETRIES_ANDROID" ;;
    ios)     echo "$RETRIES_IOS" ;;
    *)       echo 0 ;;
  esac
}

set_platform_retries() {
  case "$1" in
    android) RETRIES_ANDROID=$2 ;;
    ios)     RETRIES_IOS=$2 ;;
  esac
}

# Find workflow runs triggered during Phase 3
get_triggered_runs() {
  gh run list --workflow="$GH_WORKFLOW" --repo "$GH_REPO" \
    --json databaseId,status,conclusion,createdAt --limit 20 2>/dev/null | \
    jq --arg since "$PHASE3_START_ISO" \
      '[.[] | select(.createdAt >= $since)]'
}

# Wait for a specific run to reach a terminal state; returns 0 on completion, 1 on timeout
wait_for_run() {
  local run_id=$1
  local deadline=$(( $(date +%s) + BUILD_POLL_TIMEOUT ))
  while true; do
    local status
    status=$(gh run view "$run_id" --repo "$GH_REPO" --json status --jq '.status' 2>/dev/null) || {
      log "WARNING: Failed to query run $run_id"
      return 1
    }
    if [[ "$status" == "completed" ]]; then
      return 0
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      log "WARNING: Poll timeout reached for run $run_id (status: $status)"
      return 1
    fi
    log "Run $run_id status: $status, waiting..."
    sleep "$BUILD_POLL_INTERVAL"
  done
}

# Get failed platform(s) from a completed run's job results
# Outputs space-separated platform names (android ios)
get_failed_platforms() {
  local run_id=$1
  local failed_jobs
  failed_jobs=$(gh run view "$run_id" --repo "$GH_REPO" --json jobs \
    --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join("\n")' 2>/dev/null) || return
  local result=""
  if echo "$failed_jobs" | grep -qi "android"; then result="android"; fi
  if echo "$failed_jobs" | grep -qi "ios"; then result="$result ios"; fi
  echo "$result"
}

# Track retry counts per platform (scalar variables for bash 3.2 compatibility)
RETRIES_ANDROID=0
RETRIES_IOS=0

# Initial discovery: wait briefly for runs to appear, then collect them
sleep 10
RUNS_JSON=$(get_triggered_runs 2>/dev/null) || RUNS_JSON="[]"
RUN_COUNT=$(echo "$RUNS_JSON" | jq 'length')

if [[ "$RUN_COUNT" -eq 0 ]]; then
  log "No GitHub Actions builds found from this run. Skipping Phase 4."
else
  ROUND=0
  while true; do
    ROUND=$((ROUND + 1))

    if [[ $(date +%s) -ge $PHASE4_DEADLINE ]]; then
      log "Phase 4 hard deadline reached. Stopping build monitoring."
      break
    fi

    log "--- Build monitoring round $ROUND ---"

    # Re-fetch runs (includes any retries triggered in previous rounds)
    RUNS_JSON=$(get_triggered_runs 2>/dev/null) || RUNS_JSON="[]"
    RUN_COUNT=$(echo "$RUNS_JSON" | jq 'length')
    SUCCEEDED=0
    FAILED=0
    NEEDS_ANOTHER_ROUND=false

    for RUN_ROW in $(echo "$RUNS_JSON" | jq -r '.[] | @base64'); do
      RUN_DATA=$(echo "$RUN_ROW" | base64 --decode)
      RUN_ID=$(echo "$RUN_DATA" | jq -r '.databaseId')
      RUN_STATUS=$(echo "$RUN_DATA" | jq -r '.status')

      # Wait for in-progress runs
      if [[ "$RUN_STATUS" != "completed" ]]; then
        wait_for_run "$RUN_ID" || true
      fi

      # Check conclusion
      CONCLUSION=$(gh run view "$RUN_ID" --repo "$GH_REPO" --json conclusion --jq '.conclusion' 2>/dev/null) || CONCLUSION="unknown"

      if [[ "$CONCLUSION" == "success" ]]; then
        SUCCEEDED=$((SUCCEEDED + 1))
        continue
      fi

      if [[ "$CONCLUSION" != "failure" ]]; then
        log "Run $RUN_ID has conclusion: $CONCLUSION, skipping."
        continue
      fi

      FAILED=$((FAILED + 1))

      # Identify which platform(s) failed
      FAILED_PLATS=$(get_failed_platforms "$RUN_ID")
      if [[ -z "$FAILED_PLATS" ]]; then
        log "Run $RUN_ID failed but could not determine which platform. Manual intervention needed."
        continue
      fi

      # Process each failed platform (use for loop to avoid subshell from piping)
      for PLATFORM in $FAILED_PLATS; do
        RETRIES=$(get_platform_retries "$PLATFORM")
        if [[ "$RETRIES" -ge "$MAX_BUILD_RETRIES" ]]; then
          log "Platform $PLATFORM: already retried $RETRIES times, skipping. Manual intervention needed."
          continue
        fi

        log "Platform $PLATFORM failed in run $RUN_ID"
        log "Attempting fix (retry $((RETRIES + 1))/$MAX_BUILD_RETRIES)..."

        if ! claude -p "$(cat <<PROMPT
You are an automated nightly job fixing a failed GitHub Actions mobile build for JakubAnderwald/drafto.

**Failed build details:**
- Platform: $PLATFORM
- GitHub Actions run ID: $RUN_ID
- Run URL: https://github.com/$GH_REPO/actions/runs/$RUN_ID

**Your task:**
1. Diagnose the build failure:
   - Fetch the failed job logs: gh run view $RUN_ID --repo $GH_REPO --log-failed
   - If the error is a native build error (Gradle/Xcode), look at the error message and search the codebase for the affected code.
   - Common causes: missing native dependencies after adding an Expo package (need expo prebuild), incompatible native code, misconfigured Fastlane settings.

2. Fix the issue:
   - Create a worktree branch (e.g., fix/${PLATFORM}-build).
   - Make the minimal fix needed. Common fixes include:
     - Running \`npx expo prebuild --clean\` to regenerate native projects
     - Adding missing native dependencies or plugins to app.config.ts
     - Fixing Fastlane configuration in apps/mobile/fastlane/Fastfile
     - Fixing native code compilation errors
   - Run local checks: pnpm lint && pnpm typecheck && cd apps/mobile && pnpm test
   - Use /push to commit, push, create PR, and wait for CI green.
   - Squash-merge via gh api.

3. Retrigger the build:
   - gh workflow run $GH_WORKFLOW --repo $GH_REPO -f platform=$PLATFORM

4. Comment on any related support issues (check recent closed issues with "support" label) with the fix status.

Constraints:
- Never push directly to main. Always branches + PRs.
- Never modify production data.
- If you cannot diagnose or fix the issue, comment on a new GitHub issue with the build error details and add label "needs-manual-intervention".
PROMPT
        )" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"; then
          log "ERROR: Fix attempt for $PLATFORM build failed"
        fi

        set_platform_retries "$PLATFORM" $((RETRIES + 1))
        NEEDS_ANOTHER_ROUND=true
        log "--- Done with $PLATFORM build fix attempt ---"
      done
    done

    log "Build results: $SUCCEEDED succeeded, $FAILED failed (of $RUN_COUNT runs)"

    if [[ "$FAILED" -eq 0 ]]; then
      log "All GitHub Actions builds succeeded."
      break
    fi

    if [[ "$NEEDS_ANOTHER_ROUND" == false ]]; then
      log "No more builds to retry. Exiting Phase 4."
      break
    fi

    # Wait for newly dispatched runs to appear
    sleep 10
    log "Retriggered builds — starting next monitoring round..."
  done
fi

# Final build status summary
FINAL_RUNS=$(get_triggered_runs 2>/dev/null) || FINAL_RUNS="[]"
FINAL_SUCCEEDED=$(echo "$FINAL_RUNS" | jq '[.[] | select(.conclusion == "success")] | length')
FINAL_FAILED=$(echo "$FINAL_RUNS" | jq '[.[] | select(.conclusion == "failure")] | length')
FINAL_PENDING=$(echo "$FINAL_RUNS" | jq '[.[] | select(.status != "completed")] | length')
log "Phase 4 summary: $FINAL_SUCCEEDED succeeded, $FINAL_FAILED failed, $FINAL_PENDING still pending"

if [[ "$FINAL_FAILED" -gt 0 ]]; then
  log "WARNING: Some builds still failing after retries. Manual intervention needed."
  for ISSUE_NUMBER in "${PHASE3_ISSUE_NUMBERS[@]}"; do
    FAILED_PLATFORMS=$(echo "$FINAL_RUNS" | jq -r '[.[] | select(.conclusion == "failure") | .databaseId] | join(", ")')
    gh issue comment "$ISSUE_NUMBER" --repo "$GH_REPO" --body "${NIGHTLY_MARKER}
## Build monitoring update

After $ROUND round(s) of automated fix attempts, some mobile builds are still failing:
- **Failed run IDs**: $FAILED_PLATFORMS
- **Retries exhausted**: $MAX_BUILD_RETRIES per platform

See the [Actions tab](https://github.com/$GH_REPO/actions/workflows/$GH_WORKFLOW) for details.
Manual intervention is required to resolve the remaining build issues.
" 2>/dev/null || log "WARNING: Failed to comment on issue #$ISSUE_NUMBER"
    gh issue edit "$ISSUE_NUMBER" --repo "$GH_REPO" --add-label "needs-manual-intervention" 2>/dev/null || true
  done
fi

ELAPSED=$(( $(date +%s) - START_TIME ))
log "=== Nightly support run completed in ${ELAPSED}s ==="
