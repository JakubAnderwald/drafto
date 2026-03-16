#!/bin/bash
set -euo pipefail

LOG_DIR="$HOME/code/drafto/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/nightly-$(date +%Y-%m-%d).log"

cd "$HOME/code/drafto"

claude -p "$(cat <<'PROMPT'
You are an automated nightly job. Process open GitHub issues and Dependabot PRs for JakubAnderwald/drafto.

## Step 1: Gather open items

1. gh issue list --label support --state open --json number,title,body --limit 50
2. gh pr list --author "app/dependabot" --state open --json number,title,body --limit 50

If nothing is open, log "No items to process" and exit.

## Step 2: Process Dependabot PRs

For each open Dependabot PR:
1. Read the PR to understand the dependency update (minor/patch vs major).
2. Check CI: gh pr checks {number}
3. Decision:
   - CI passes + minor/patch → squash merge via gh api, comment "Auto-merged: CI passed, minor/patch update."
   - CI fails → close with comment explaining which checks failed.
   - Major version bump → close with comment "Major version bump requires manual review", add label "needs-review".
   - CI pending → skip (process next night).

## Step 3: Process support issues

For each open issue labeled "support" (max 3 per run):
1. Check the "From:" field in the body.
2. Only process issues from jakub@anderwald.info or joanna@anderwald.info.
   - Other senders → comment "Sender not recognized, needs manual triage", add label "needs-triage", skip.
3. Analyze: feature request or bug report?
4. Create a worktree branch for the work.
5. Implement following CLAUDE.md guidelines (SOLID, strict TS, named exports, kebab-case, design system tokens).
6. Add unit + integration tests.
7. Run: pnpm lint && pnpm typecheck && pnpm test
8. Use /push to commit, push, create PR referencing "Closes #N", wait for CI.
9. Comment on issue: "Addressed in PR #M."

## Constraints
- Never push directly to main. Always branches + PRs.
- Never modify production data or run database migrations.
- If DB changes needed: create migration file, add label "needs-migration-review", comment that manual deploy is required.
- If stuck: comment on issue with the problem, add label "needs-manual-intervention".
PROMPT
)" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"
