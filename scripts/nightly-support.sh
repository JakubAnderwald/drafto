#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/nightly-$(date +%Y-%m-%d).log"

cd "$REPO_ROOT"

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
   - Major version bump → add label "needs-review", comment "Major version bump requires manual review", leave PR open.
   - CI pending → skip (process next night).

## Step 3: Process support issues

For each open issue labeled "support" (max 3 per run):
1. Verify the issue was created by the trusted bot account (github-actions[bot] or the configured Apps Script service account) to ensure it originated from Stage 1.
2. Check the "From:" field in the body. Only process issues from jakub@anderwald.info or joanna@anderwald.info.
   - Issue not created by the trusted bot → comment "Issue creator not recognized as trusted pipeline bot, needs manual triage", add label "needs-triage", skip.
   - Other senders → comment "Sender not recognized, needs manual triage", add label "needs-triage", skip.
3. Analyze: feature request or bug report?
4. Create a worktree branch for the work.
5. Implement following CLAUDE.md guidelines (SOLID, strict TS, named exports, kebab-case, design system tokens).
6. Add unit + integration tests.
7. Run full pre-push verification (per CLAUDE.md):
   - cd apps/web && pnpm test (unit + integration)
   - cd apps/web && pnpm test:coverage (verify adequate coverage)
   - set -a && source apps/web/.env.local && set +a && cd apps/web && pnpm test:e2e (Playwright E2E)
   - cd packages/shared && pnpm test (shared package tests)
   - cd apps/mobile && pnpm test (mobile unit tests)
   - pnpm lint && pnpm typecheck
8. Use /push to commit, push, create PR referencing "Closes #N", wait for CI.
9. Comment on issue: "Addressed in PR #M."

## Constraints
- Never push directly to main. Always branches + PRs.
- Never modify production data or run database migrations.
- If DB changes needed: create migration file, add label "needs-migration-review", comment that manual deploy is required.
- If stuck: comment on issue with the problem, add label "needs-manual-intervention".
PROMPT
)" --dangerously-skip-permissions 2>&1 | tee -a "$LOG_FILE"
