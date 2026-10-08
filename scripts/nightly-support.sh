#!/bin/bash
set -euo pipefail

# Ensure ~/.local/bin is in PATH (claude CLI location; launchd has minimal PATH).
# sbin is appended (never shadowing anything) because macOS keeps lsof there,
# which the Phase 4 lane killer uses to find a hung build's process group.
export PATH="$HOME/.local/bin:$PATH:/usr/sbin:/sbin"

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
# Phase 4 lane logs (+ their .exit codes and the pending snapshot each run
# settled against). Same 30-day window; a lane is waited for in-run, so
# nothing live is ever this old.
RELEASE_LOG_DIR="$LOG_DIR/support-release"
mkdir -p "$RELEASE_LOG_DIR"
find "$RELEASE_LOG_DIR" -type f -mtime +30 -delete 2>/dev/null || true

cd "$REPO_ROOT"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
# For functions whose stdout the caller captures (ensure_beta_build_root prints
# the build-root path): the log file only — same contract as factory-agent.sh.
logerr() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

# ── Knobs ──
# Wall-clock caps for each `claude -p` session (scripts/lib/run-claude.mjs exits
# 124 on the cap). A support fix runs the full pre-push matrix and /push's CI
# loop; a Dependabot PR at most a CI fix.
SUPPORT_CLAUDE_TIMEOUT_SEC="${SUPPORT_CLAUDE_TIMEOUT_SEC:-7200}"
DEPENDABOT_CLAUDE_TIMEOUT_SEC="${DEPENDABOT_CLAUDE_TIMEOUT_SEC:-3600}"
# pnpm / bundle install cap inside the beta build roots (beta-build-root.sh).
INSTALL_TIMEOUT_SEC="${SUPPORT_INSTALL_TIMEOUT_SEC:-600}"
# Phase 4: how long to wait for main's required checks, how often to look at a
# running lane, when a lane counts as dead (log silent) or hung (still running).
SUPPORT_MAIN_CI_WAIT_MIN="${SUPPORT_MAIN_CI_WAIT_MIN:-45}"
SUPPORT_LANE_POLL_SEC="${SUPPORT_LANE_POLL_SEC:-60}"
SUPPORT_LANE_STALE_MIN="${SUPPORT_LANE_STALE_MIN:-120}"
SUPPORT_LANE_MAX_MIN="${SUPPORT_LANE_MAX_MIN:-180}"
SUPPORT_LANE_KILL_GRACE_SEC="${SUPPORT_LANE_KILL_GRACE_SEC:-10}"
# A non-numeric override would silently disable a cap (or make run-with-timeout
# exit on its usage path), so validate before anything uses them.
for _knob in SUPPORT_CLAUDE_TIMEOUT_SEC:7200 DEPENDABOT_CLAUDE_TIMEOUT_SEC:3600 \
    INSTALL_TIMEOUT_SEC:600 SUPPORT_MAIN_CI_WAIT_MIN:45 SUPPORT_LANE_POLL_SEC:60 \
    SUPPORT_LANE_STALE_MIN:120 SUPPORT_LANE_MAX_MIN:180 SUPPORT_LANE_KILL_GRACE_SEC:10; do
  _name="${_knob%%:*}"
  _default="${_knob##*:}"
  if ! [[ "${!_name}" =~ ^[1-9][0-9]*$ ]]; then
    echo "WARNING: invalid $_name='${!_name}'; defaulting to $_default" >&2
    printf -v "$_name" '%s' "$_default"
  fi
done
unset _knob _name _default
# Where the support / Dependabot sessions create their worktrees. Fixed paths,
# so the runner can remove exactly that worktree once the work is merged.
SUPPORT_WORKTREE_PARENT="${SUPPORT_WORKTREE_PARENT:-$HOME/code}"

# In `-p` mode claude kills background tasks 600 s after its final turn. Wait
# without a ceiling instead — every call below is bounded by run-claude.mjs's
# wall cap — so a session can never again end with work still in flight (#658:
# the release lanes were background tasks and died with the session).
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0

NIGHTLY_MARKER='<!-- nightly-bot -->'
# Progress-comment marker (Phase G). Bot-authored issue comments carrying
# this string are forwarded to the customer by support-agent.sh's
# --comment-sync sweep; bot-authored comments without it (e.g. the
# customer-echo "Customer replied via support@drafto.eu" forwards) are
# suppressed to avoid an echo loop. Keep this in sync with PROGRESS_MARKER
# in scripts/lib/github-sync.mjs.
PROGRESS_MARKER='<!-- drafto-progress -->'

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

# Beta build roots shared with the dark factory (ADR-0042): ensure / claim /
# release_beta_build_root and BETA_MOBILE_ROOT / BETA_DESKTOP_ROOT. Contract:
# REPO_ROOT, SCRIPT_DIR, LOG_FILE, INSTALL_TIMEOUT_SEC, log, logerr — all set
# above. Sourced after the trap so a missing lib still files a nightly-failure.
# This checkout IS the desktop fossil, so the desktop root is cloned from it
# (DESKTOP_FOSSIL_ROOT defaults to /Users/jakub/code/drafto); the lib refuses
# to use this checkout itself as a build root.
# shellcheck source=lib/beta-build-root.sh
source "$SCRIPT_DIR/lib/beta-build-root.sh"

# ── Phase 1: Gather items ──
START_TIME=$(date +%s)
log "=== Nightly support run started ==="

DEPENDABOT_PRS=$(gh pr list --repo JakubAnderwald/drafto --author "app/dependabot" \
  --state open --json number,title,labels --limit 50 2>/dev/null) || DEPENDABOT_PRS="[]"
# Pull labels too — we filter out issues already marked needs-triage so we
# don't re-comment on rejected reporters every nightly run. Body is no longer
# needed here (the Phase F gate moved off issue-body footer parsing — see
# ADR-0025) but we keep it in the query so existing downstream consumers in
# the loop don't break.
SUPPORT_ISSUES=$(gh issue list --repo JakubAnderwald/drafto --label support --state open --json number,title,body,labels --limit 50 2>/dev/null) || SUPPORT_ISSUES="[]"

# Skip Dependabot PRs already labeled needs-review (processed in a prior run)
DEPENDABOT_ALL_COUNT=$(echo "$DEPENDABOT_PRS" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch Dependabot PRs"; DEPENDABOT_ALL_COUNT=0; }
DEPENDABOT_PRS=$(echo "$DEPENDABOT_PRS" | \
  jq '[.[] | select(.labels | map(.name) | index("needs-review") | not)]') || DEPENDABOT_PRS="[]"
DEPENDABOT_COUNT=$(echo "$DEPENDABOT_PRS" | jq 'length') || DEPENDABOT_COUNT=0
# Skip support issues already triaged (Phase F gate added needs-triage on a
# prior run). Dependabot uses the same pattern with needs-review.
# Exception: if a human triager applied `support-allowlisted` (manual override
# of the ADR-0025 sender gate, e.g. for legacy issues filed before sender
# persistence existed), keep the issue in the queue even with needs-triage so
# the next nightly run picks it up. The Phase F gate below also short-circuits
# on this label.
SUPPORT_ISSUES_ALL_COUNT=$(echo "$SUPPORT_ISSUES" | jq -e 'length' 2>/dev/null) || { log "ERROR: Failed to fetch support issues"; SUPPORT_ISSUES_ALL_COUNT=0; }
SUPPORT_ISSUES=$(echo "$SUPPORT_ISSUES" | \
  jq '[.[] | select((.labels | map(.name) | index("needs-triage") | not) or (.labels | map(.name) | index("support-allowlisted")))]') || SUPPORT_ISSUES="[]"
SUPPORT_COUNT=$(echo "$SUPPORT_ISSUES" | jq 'length') || SUPPORT_COUNT=0
SUPPORT_TRIAGED_COUNT=$(( SUPPORT_ISSUES_ALL_COUNT - SUPPORT_COUNT ))

SKIPPED_COUNT=$(( DEPENDABOT_ALL_COUNT - DEPENDABOT_COUNT ))
log "Found $DEPENDABOT_ALL_COUNT Dependabot PRs ($SKIPPED_COUNT already labeled needs-review, $DEPENDABOT_COUNT to process), $SUPPORT_COUNT support issues ($SUPPORT_TRIAGED_COUNT already labeled needs-triage)"

# Merged support fixes still waiting for a beta (Phase 4). Checked here too so
# a night with no open issue still retries a fix whose build failed earlier —
# the old early exit meant nothing ever retried. A fix that just ran out of the
# window and still needs its operator flag counts too, as does an issue the
# lookup failed for. -1 = unknown (lookup failed): never "nothing to do".
PENDING_COUNT=-1
if PENDING_JSON=$(node "$SCRIPT_DIR/lib/support-release.mjs" pending 2>>"$LOG_FILE"); then
  PENDING_COUNT=$(echo "$PENDING_JSON" \
    | jq '(.issues | length) + ([.expired[]? | select(.alreadyFlagged | not)] | length) + (.errors // [] | length)' \
    2>/dev/null) || PENDING_COUNT=-1
  [[ "$PENDING_COUNT" =~ ^[0-9]+$ ]] || PENDING_COUNT=-1
fi
if [[ "$PENDING_COUNT" -ge 0 ]]; then
  log "Found $PENDING_COUNT merged support fix(es) awaiting a beta build"
else
  log "WARNING: could not list merged support fixes awaiting a beta; Phase 4 will retry"
fi

if [[ "$DEPENDABOT_COUNT" -eq 0 && "$SUPPORT_COUNT" -eq 0 && "$PENDING_COUNT" -eq 0 ]]; then
  log "No items to process."
  log "=== Nightly support run completed (no items) ==="
  exit 0
fi

# Remove a session's fixed-path worktree once its work has landed. Only that
# exact path, and only when git has it registered as a worktree of this repo —
# never a directory that merely happens to exist there. A fix/support-<n>
# branch the session created is dropped with it (the PR is merged; the remote
# keeps the history). $1 path, $2 branch to delete with it (optional).
remove_session_worktree() {
  local wt="$1" branch="${2:-}" canon listing match wt_branch
  # Nothing on disk → nothing to remove. git may list the path as given or
  # symlink-resolved, so match either spelling.
  canon=$(cd "$wt" 2>/dev/null && pwd -P) || return 0
  listing=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null) || return 0
  if grep -Fxq "worktree $wt" <<<"$listing"; then
    match="$wt"
  elif grep -Fxq "worktree $canon" <<<"$listing"; then
    match="$canon"
  else
    return 0
  fi
  wt_branch=$(awk -v wt="worktree $match" '$0 == wt {f=1; next} f && /^branch / {sub(/^branch refs\/heads\//, ""); print; exit} f && /^$/ {exit}' <<<"$listing")
  if git -C "$REPO_ROOT" worktree remove --force "$match" >>"$LOG_FILE" 2>&1; then
    log "Removed worktree $match"
    if [[ -n "$branch" && "$wt_branch" == "$branch" ]]; then
      git -C "$REPO_ROOT" branch -D "$branch" >>"$LOG_FILE" 2>&1 || true
    fi
  else
    log "WARNING: could not remove worktree $wt; leaving it for the operator"
  fi
}

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
  DEPENDABOT_WT="$SUPPORT_WORKTREE_PARENT/drafto-dependabot-${PR_NUMBER}"
  # Keep the double-quoted "$(cat <<PROMPT … )" form for both prompts: macOS
  # /bin/bash 3.2 mis-parses an UNquoted $(…) around a heredoc that contains
  # apostrophes and parentheses (syntax error at a "(" inside the text). And
  # keep apostrophes out of new prompt text: 3.2 still pairs them up.
  DEPENDABOT_PROMPT="$(cat <<PROMPT
You are an automated nightly job. Process ONLY Dependabot PR #$PR_NUMBER for JakubAnderwald/drafto.

1. Read the PR: gh pr view $PR_NUMBER --json title,body,headRefName
2. Check CI: gh pr checks $PR_NUMBER
3. Decision:
   - CI passes + minor/patch → squash merge via gh api, comment "${NIGHTLY_MARKER}Auto-merged: CI passed, minor/patch update."
   - CI fails + minor/patch → in the dedicated worktree (see Constraints) use /push to fix failures and iterate until CI is green, then squash merge.
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

Constraints:
- ${REPO_ROOT} is the primary checkout and holds the fossil node_modules of
  the macOS desktop build (see apps/desktop/CLAUDE.md). NEVER run pnpm install,
  git checkout / switch / pull / reset / merge / clean, or edit files there.
- To fix a failing PR, work in a dedicated worktree instead:
    git -C ${REPO_ROOT} fetch origin <headRefName>
    git -C ${REPO_ROOT} worktree add -B <headRefName> ${DEPENDABOT_WT} origin/<headRefName>
  (reuse ${DEPENDABOT_WT} if it already exists), then pnpm install and
  bash scripts/worktree-bootstrap.sh there, and run /push from it.
- Never start a background task that must outlive this session: it is
  killed when the session ends.
PROMPT
  )"
  CLAUDE_RC=0
  CLAUDE_CALL_TIMEOUT_SEC="$DEPENDABOT_CLAUDE_TIMEOUT_SEC" \
    node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$DEPENDABOT_PROMPT" --dangerously-skip-permissions 2>&1 \
    | tee -a "$LOG_FILE" || CLAUDE_RC=$?
  if [[ "$CLAUDE_RC" -eq 124 ]]; then
    log "ERROR: Dependabot PR #$PR_NUMBER session hit the ${DEPENDABOT_CLAUDE_TIMEOUT_SEC}s cap; continuing with next item"
  elif [[ "$CLAUDE_RC" -ne 0 ]]; then
    log "ERROR: Dependabot PR #$PR_NUMBER failed (exit $CLAUDE_RC); continuing with next item"
  fi
  # A worktree is only useful while the PR is open (a later night may need it).
  if [[ "$(gh pr view "$PR_NUMBER" --repo JakubAnderwald/drafto --json state --jq .state 2>/dev/null || echo "")" =~ ^(MERGED|CLOSED)$ ]]; then
    remove_session_worktree "$DEPENDABOT_WT"
  fi
  log "--- Done with PR #$PR_NUMBER ---"
done

# ── Phase 3: Process support issues (one session each, max 10) ──
PROCESSED=0
# C-style, not `seq 0 $((SUPPORT_COUNT - 1))`: BSD seq counts DOWN when the end
# is below the start, so a night with no support issue iterated "0 -1" and
# logged "Issue #null".
for ((IDX=0; IDX<SUPPORT_COUNT; IDX++)); do
  if [[ "$PROCESSED" -ge 10 ]]; then
    log "Reached max 10 support issues per run, skipping remaining."
    break
  fi
  ISSUE_ENTRY=$(echo "$SUPPORT_ISSUES" | jq ".[${IDX}]")
  ISSUE_NUMBER=$(echo "$ISSUE_ENTRY" | jq -r '.number')

  # ── Phase F gate: sender-based allowlist check (ADR-0025) ──
  # Pre-gate before invoking Claude, so a non-allowlisted reporter doesn't
  # burn a full Claude session. The reporter email is the inbound Zoho
  # `fromAddress` captured by support-agent.sh BEFORE invoking the LLM
  # (recorded into logs/support-state.json). Reading from state, not from
  # an LLM-written issue-body footer, eliminates the spoof window where a
  # crafted email could trick the LLM into copying a forged
  # `reporter-allowlisted: true` block into the issue body.
  #
  # Manual override: a `support-allowlisted` label, applied by a human
  # triager (only repo collaborators can add labels — GitHub-authenticated,
  # not LLM-mediated), short-circuits the gate. This handles legacy issues
  # filed before sender persistence existed (ADR-0025 "Negative" point) and
  # any one-off backfill the operator wants to run from outside the Mac mini
  # without touching state.json directly.
  HAS_OVERRIDE=$(echo "$ISSUE_ENTRY" | jq -r '.labels // [] | map(.name) | index("support-allowlisted") | tostring')
  GATE_REASON=""
  REPORTER_EMAIL=""
  if [[ "$HAS_OVERRIDE" != "null" ]]; then
    log "Issue #$ISSUE_NUMBER: support-allowlisted label present; bypassing sender gate"
  else
    REPORTER_EMAIL=$(node "$SCRIPT_DIR/lib/state-cli.mjs" get-reporter-email "$ISSUE_NUMBER" \
      2>/dev/null || true)
    if [[ -z "$REPORTER_EMAIL" ]]; then
      # No state entry. Either a legacy issue filed before ADR-0025, an issue
      # filed manually outside the agent, or the agent ran but the runner
      # failed to persist (logged at filing time). Fall through to triage —
      # human can backfill state or apply `support-allowlisted` to bypass.
      GATE_REASON="unknown-sender"
    else
      # Comma-bounded glob match against the lower-cased CSV. `,X,Y,Z,` always
      # has commas at both ends so the pattern `*,<email>,*` matches at any
      # position. state-cli stores reporterEmail already lower-cased; we lower
      # the allowlist here too so user-edited support-env.sh casing doesn't
      # leak through. Use `tr` (POSIX) instead of `${VAR,,}` (bash 4+) so the
      # script keeps working under macOS's stock /bin/bash 3.2 — launchd
      # invokes that interpreter on the Mac mini.
      SUPPORT_ALLOWLIST_LC=$(printf '%s' "$SUPPORT_ALLOWLIST" | tr '[:upper:]' '[:lower:]')
      REPORTER_EMAIL_LC=$(printf '%s' "$REPORTER_EMAIL" | tr '[:upper:]' '[:lower:]')
      if [[ ",${SUPPORT_ALLOWLIST_LC}," != *",${REPORTER_EMAIL_LC},"* ]]; then
        GATE_REASON="not-allowlisted"
      fi
    fi
  fi
  if [[ -n "$GATE_REASON" ]]; then
    log "Issue #$ISSUE_NUMBER: gate rejected (reason=$GATE_REASON, sender=${REPORTER_EMAIL:-<none>}); marking needs-triage"
    gh issue comment "$ISSUE_NUMBER" --repo JakubAnderwald/drafto \
      --body "Reporter not on the support allowlist (reason: ${GATE_REASON}). Needs manual triage." \
      2>/dev/null || log "WARNING: failed to comment on issue #$ISSUE_NUMBER"
    gh issue edit "$ISSUE_NUMBER" --repo JakubAnderwald/drafto \
      --add-label needs-triage \
      2>/dev/null || log "WARNING: failed to add needs-triage to issue #$ISSUE_NUMBER"
    continue
  fi

  log "--- Processing support issue #$ISSUE_NUMBER (gate passed) ---"

  # Phase G progress comment (a): "Working on it now" before Claude starts.
  # Idempotent — skip if a previous nightly run already posted one (or if the
  # earlier "Hit a blocker" comment is present, in which case we'd be
  # re-trying a stuck issue and don't need a fresh "starting" ping).
  if PRIOR_COMMENTS=$(gh api --paginate "repos/JakubAnderwald/drafto/issues/${ISSUE_NUMBER}/comments" \
        --jq '.[].body // empty' 2>/dev/null) && \
      ! grep -Fq "$PROGRESS_MARKER" <<<"$PRIOR_COMMENTS"; then
    gh issue comment "$ISSUE_NUMBER" --repo JakubAnderwald/drafto \
      --body "Working on it now (from the nightly agent). ${PROGRESS_MARKER}" \
      2>/dev/null || log "WARNING: failed to post 'working on it' comment on issue #$ISSUE_NUMBER"
  fi

  SUPPORT_WT="$SUPPORT_WORKTREE_PARENT/drafto-support-${ISSUE_NUMBER}"
  SUPPORT_BRANCH="fix/support-${ISSUE_NUMBER}"
  SUPPORT_PROMPT="$(cat <<PROMPT
You are an automated nightly job. Process ONLY support issue #${ISSUE_NUMBER} for JakubAnderwald/drafto.

The issue has already passed the support-agent footer gate (reporter is on \$SUPPORT_ALLOWLIST). Skip any From: / sender re-checks.

A "Working on it now" progress comment has already been posted on the issue
by the runner before this Claude session — do NOT re-post it. The comments
you DO need to emit are the ones below tagged "Phase G progress comment".
All Phase G progress comments must end with the literal marker
${PROGRESS_MARKER} so support-agent.sh's --comment-sync sweep forwards them
to the customer's Zoho thread (bot-authored comments without the marker are
suppressed to break the customer→GH→Zoho echo loop).

1. Read the issue: gh issue view ${ISSUE_NUMBER} --json title,body,author,createdAt
2. Verify the issue has the "support" label (applied by the Stage 1 ingest pipeline).
   - If the label is missing → comment "Issue missing support label, needs manual triage", add label "needs-triage", exit.
3. Analyze: feature request or bug report?
4. Create a git worktree at ${SUPPORT_WT} on branch ${SUPPORT_BRANCH} from origin/main:
     git -C ${REPO_ROOT} fetch origin main
     git -C ${REPO_ROOT} worktree add -b ${SUPPORT_BRANCH} ${SUPPORT_WT} origin/main
   If ${SUPPORT_WT} already exists (left by an earlier night), reuse it; if only
   the branch exists, use: git -C ${REPO_ROOT} worktree add ${SUPPORT_WT} ${SUPPORT_BRANCH}
   Then cd into ${SUPPORT_WT}, run pnpm install and bash scripts/worktree-bootstrap.sh,
   and do ALL remaining work there.
5. Implement following CLAUDE.md guidelines (SOLID, strict TS, named exports, kebab-case, design system tokens).
6. Add unit + integration tests.
7. Run full pre-push verification (per CLAUDE.md).
8. Use /push to commit, push, create PR referencing "Closes #${ISSUE_NUMBER}", wait for CI.
   **Phase G progress comment (b)** — immediately after the PR is created
   (before /push starts polling CI), post:
   gh issue comment ${ISSUE_NUMBER} --body "Fix in review: <PR url>. ${PROGRESS_MARKER}"
   Substitute <PR url> with the URL printed by gh pr create.
9. Once CI is green and every review thread is addressed, replied to and
   resolved (per CLAUDE.md), squash-merge via the API and delete the branch:
     gh api --method PUT repos/JakubAnderwald/drafto/pulls/<n>/merge -f merge_method=squash
     gh api -X DELETE repos/JakubAnderwald/drafto/git/refs/heads/${SUPPORT_BRANCH}
10. STOP after the merge. Do not post a "merged" or "shipped" comment: the
    support pipeline emails the reporter when the issue closes, and the runner
    that started this session builds and ships the beta apps after it ends;
    each build is announced on the issue as it lands.

Constraints:
- Never ship an app: no Fastlane lane, no \`pnpm release:*\` script, no
  \`bundle exec fastlane\`, nothing that signs or uploads a build. Shipping is
  the job of the runner, after this session.
- Never start a background task that must outlive this session: it is
  killed when the session ends.
- ${REPO_ROOT} is the primary checkout and holds the fossil node_modules of
  the macOS desktop build (see apps/desktop/CLAUDE.md). NEVER run pnpm install,
  git checkout / switch / pull / reset / merge / clean, or edit files there;
  against it only \`git -C ${REPO_ROOT} fetch\` and \`worktree add\` are allowed.
- Never push directly to main. Always branches + PRs.
- Never modify production data or run database migrations.
- If DB changes needed: create migration file, add label "needs-migration-review", comment that manual deploy is required.
- If stuck: add label "needs-manual-intervention", post a detailed comment
  describing the problem (no marker), AND post a customer-facing
  **Phase G progress comment (c)**:
  gh issue comment ${ISSUE_NUMBER} --body "Hit a blocker; flagged for human review. ${PROGRESS_MARKER}"
PROMPT
  )"
  CLAUDE_RC=0
  CLAUDE_CALL_TIMEOUT_SEC="$SUPPORT_CLAUDE_TIMEOUT_SEC" \
    node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$SUPPORT_PROMPT" --dangerously-skip-permissions 2>&1 \
    | tee -a "$LOG_FILE" || CLAUDE_RC=$?
  if [[ "$CLAUDE_RC" -eq 124 ]]; then
    log "ERROR: Support issue #$ISSUE_NUMBER session hit the ${SUPPORT_CLAUDE_TIMEOUT_SEC}s cap; continuing with next item"
  elif [[ "$CLAUDE_RC" -ne 0 ]]; then
    log "ERROR: Support issue #$ISSUE_NUMBER failed (exit $CLAUDE_RC); continuing with next item"
  fi
  # Merged (the PR's "Closes #N" closed the issue) → the worktree has done its
  # job. Still open → keep it for the next night to resume in.
  if [[ "$(gh issue view "$ISSUE_NUMBER" --repo JakubAnderwald/drafto --json state --jq .state 2>/dev/null || echo "")" == "CLOSED" ]]; then
    remove_session_worktree "$SUPPORT_WT" "$SUPPORT_BRANCH"
  fi
  log "--- Done with issue #$ISSUE_NUMBER ---"
  PROCESSED=$((PROCESSED + 1))
done

# ── Phase 4: Ship merged support fixes as beta builds (ADR-0042) ──
# The Claude session stops at the merge; THIS runner ships the betas, because a
# runner can wait for them. On #658 the session started the Fastlane lanes as
# background tasks and ended its turn, and `claude -p` took them down with it
# seconds in: the fix never shipped and nobody was told.
#
# For every support issue closed as completed in the last 14 days whose merged
# PR touched a native app (scripts/lib/support-release.mjs pending), and only
# once main is green: prepare the shared beta build roots (the factory's, under
# the same pid lock), dispatch the beta lanes through dispatch-release.mjs, WAIT
# for each lane's exit code, then record per platform whether the Fastlane hook
# posted the "Now live" notice — which the support agent forwards to the
# reporter. A platform that failed is retried on later nights; after 3 failures
# the issue gets needs-manual-intervention and an operator comment. Nothing that
# is merely "not now" (main CI red/pending, a root in use, the fossil check)
# consumes an attempt.
#
# Beta channels only: dispatch-release.mjs builds nothing but
# `release:beta:all` / `release:beta` and refuses any production lane.

# Terminate a lane: its process group (dispatch-release.mjs spawns each lane
# detached, so the `sh -c` wrapper leads its own group, which also holds
# fastlane's children) plus any group still holding the lane's log (children
# that outlived the wrapper). Never our own group, never 0/1. TERM, a grace
# period, then KILL. $1 lane pid, $2 lane log.
kill_support_lane() {
  local pid="$1" log_path="$2" own pgid p pgids="" lsof_bin
  own=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    # Only while it still LEADS its group: a recycled pid must not be signalled.
    if [[ "$pgid" == "$pid" && "$pgid" -gt 1 && "$pgid" != "$own" ]]; then
      pgids="$pid"
    fi
  fi
  # lsof lives in /usr/sbin on macOS (#659); PATH has it appended above, and
  # this falls back to the absolute path regardless.
  lsof_bin=$(command -v lsof 2>/dev/null || true)
  [[ -n "$lsof_bin" && -x "$lsof_bin" ]] || lsof_bin=/usr/sbin/lsof
  if [[ -x "$lsof_bin" && -f "$log_path" ]]; then
    for p in $("$lsof_bin" -t -- "$log_path" 2>/dev/null || true); do
      pgid=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ' || true)
      [[ "$pgid" =~ ^[0-9]+$ && "$pgid" -gt 1 && "$pgid" != "$own" ]] || continue
      [[ " $pgids " == *" $pgid "* ]] || pgids="$pgids $pgid"
    done
  fi
  [[ -n "${pgids// /}" ]] || return 0
  log "Phase 4: killing lane process group(s):$pgids"
  for pgid in $pgids; do kill -TERM -- "-$pgid" 2>/dev/null || true; done
  sleep "$SUPPORT_LANE_KILL_GRACE_SEC"
  for pgid in $pgids; do kill -KILL -- "-$pgid" 2>/dev/null || true; done
  return 0
}

# Runs with errexit OFF (it is called on the left of `||`), so every step
# checks its own result: an expected "not tonight" must never trip the cleanup
# trap into filing a nightly-failure issue.
ship_support_betas() {
  local pending count sha key pending_file lane csv root out pid logp exitp v code
  local started age_min reason running="" still="" lanes_arg="" logs_arg="" ci_rc f line
  local prepared=""
  # Per-lane bookkeeping without associative arrays (bash 3.2): SR_<lane>_<field>.
  for lane in mobile desktop; do
    for f in PID LOG EXIT START RESULT; do printf -v "SR_${lane}_${f}" '%s' ""; done
  done

  # --flag-expired: a fix that left the window unshipped gets its operator
  # label + comment here, once, instead of disappearing silently.
  if ! pending=$(node "$SCRIPT_DIR/lib/support-release.mjs" pending --flag-expired 2>>"$LOG_FILE"); then
    log "Phase 4: could not list merged support fixes (GitHub error?); retry next night"
    return 0
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && log "Phase 4: $line"
  done < <(echo "$pending" | jq -r '
    (.expired[]? | select(.flagged) |
      "#\(.number) \(.platforms | join("+")): left the release window unshipped — labelled needs-manual-intervention"),
    (.errors[]? | "#\(.number): skipped tonight, GitHub lookup failed (\(.error))")' 2>/dev/null || true)
  count=$(echo "$pending" | jq -r '.issues | length' 2>/dev/null || echo "")
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    log "Phase 4: unreadable pending list; retry next night"
    return 0
  fi
  if [[ "$count" -eq 0 ]]; then
    log "Phase 4: no merged support fix is waiting for a beta build"
    return 0
  fi
  log "Phase 4: awaiting a beta: $(echo "$pending" | jq -r '[.issues[] | "#\(.number) (\(.platforms | join("+")))"] | join(", ")' 2>/dev/null)"
  sha=$(echo "$pending" | jq -r '.sha // ""' 2>/dev/null || echo "")
  if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    log "Phase 4: could not resolve origin/main; retry next night"
    return 0
  fi

  # The factory skips its whole tick when the external build volume is not
  # mounted. Do the same rather than conjure fresh multi-GB build roots on the
  # internal disk — unless the operator pointed both roots somewhere explicitly.
  # And re-derive the default roots NOW: the lib picked them when it was sourced
  # at 00:03, and the volume may have been (un)mounted since — the roots must be
  # the very paths the factory's plist pins, or the shared lock means nothing.
  if [[ -z "${DRAFTO_BETA_MOBILE_ROOT:-}" || -z "${DRAFTO_DESKTOP_BUILD_ROOT:-}" ]] \
      && [[ ! -d "$BETA_BUILDS_VOLUME_DIR" ]]; then
    log "Phase 4: build volume $BETA_BUILDS_VOLUME_DIR is not mounted; retry next night"
    return 0
  fi
  resolve_beta_build_roots

  ci_rc=0
  node "$SCRIPT_DIR/lib/support-release.mjs" main-ci "$sha" --wait-min "$SUPPORT_MAIN_CI_WAIT_MIN" \
    >>"$LOG_FILE" 2>&1 || ci_rc=$?
  case "$ci_rc" in
    0) log "Phase 4: main CI is green at ${sha:0:12}" ;;
    1) log "Phase 4: main CI failed at ${sha:0:12}; not shipping it — retry next night"; return 0 ;;
    2) log "Phase 4: main CI still not green at ${sha:0:12} after ${SUPPORT_MAIN_CI_WAIT_MIN} min; retry next night"; return 0 ;;
    *) log "Phase 4: could not check main CI at ${sha:0:12} (rc=$ci_rc — see log); retry next night"; return 0 ;;
  esac

  # One key per run: a retry on a later night never shares artefacts (log,
  # .exit) with the attempt it replaces.
  key="support-${sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
  pending_file="$RELEASE_LOG_DIR/pending-$key.json"
  if ! printf '%s\n' "$pending" >"$pending_file"; then
    log "Phase 4: could not write $pending_file; retry next night"
    return 0
  fi

  # One dispatch per lane so each build announces only its own fixes: a
  # mobile-only fix must not get a "now live" from the macOS build.
  for lane in mobile desktop; do
    [[ "$(echo "$pending" | jq -r --arg l "$lane" '.lanes[$l] // false' 2>/dev/null)" == "true" ]] || continue
    csv=$(echo "$pending" | jq -r --arg l "$lane" '.laneIssues[$l] // ""' 2>/dev/null || echo "")
    root=$(ensure_beta_build_root "$lane" "$sha") || root=""
    if [[ -z "$root" ]]; then
      log "Phase 4: $lane build root unavailable (in use, or could not be prepared — see log); retry next night"
      continue
    fi
    prepared="$prepared $lane"
    out=$(node "$SCRIPT_DIR/lib/dispatch-release.mjs" dispatch --platforms "$lane" \
      --repo-root "$BETA_MOBILE_ROOT" --desktop-root "$BETA_DESKTOP_ROOT" \
      --log-dir "$RELEASE_LOG_DIR" --log-key "$key" --release-issues "$csv" 2>>"$LOG_FILE") || out=""
    pid=$(echo "$out" | jq -r '.dispatched[0].pid // empty' 2>/dev/null || echo "")
    logp=$(echo "$out" | jq -r '.dispatched[0].logPath // empty' 2>/dev/null || echo "")
    exitp=$(echo "$out" | jq -r '.dispatched[0].exitPath // empty' 2>/dev/null || echo "")
    if [[ "$pid" =~ ^[0-9]+$ && -n "$exitp" ]]; then
      claim_beta_build_root "$lane" "$pid"
      printf -v "SR_${lane}_PID" '%s' "$pid"
      printf -v "SR_${lane}_LOG" '%s' "$logp"
      printf -v "SR_${lane}_EXIT" '%s' "$exitp"
      printf -v "SR_${lane}_START" '%s' "$(date +%s)"
      running="$running $lane"
      log "Phase 4: dispatched the $lane beta lane (pid $pid) for #${csv//,/, #} at ${sha:0:12}; log $logp"
    else
      # Refused by a guard (the fossil check), unable to start, or the
      # dispatcher itself failed: not a build failure, so no attempt is spent.
      reason=$(echo "$out" | jq -r '[(.skipped[]?, .failed[]?) | .reason] | join("; ")' 2>/dev/null || echo "")
      log "Phase 4: the $lane beta lane did not start (${reason:-dispatcher error — see log}); retry next night"
      release_beta_build_root "$lane"
    fi
  done
  running="${running# }"
  if [[ -z "$running" ]]; then
    log "Phase 4: no lane started; nothing to wait for"
    return 0
  fi

  log "Phase 4: waiting for lane(s): $running (polling every ${SUPPORT_LANE_POLL_SEC}s; cap ${SUPPORT_LANE_MAX_MIN} min; dead after ${SUPPORT_LANE_STALE_MIN} silent min)"
  while [[ -n "$running" ]]; do
    sleep "$SUPPORT_LANE_POLL_SEC"
    still=""
    for lane in $running; do
      v="SR_${lane}_PID"; pid="${!v}"
      v="SR_${lane}_LOG"; logp="${!v}"
      v="SR_${lane}_EXIT"; exitp="${!v}"
      v="SR_${lane}_START"; started="${!v}"
      # The wrapper writes its exit code to <log>.exit as it finishes.
      code=""
      if [[ -f "$exitp" ]]; then
        code=$(tr -cd '0-9' <"$exitp" 2>/dev/null || true)
        code="${code:0:4}"
      fi
      if [[ -n "$code" ]]; then
        printf -v "SR_${lane}_RESULT" '%s' "$code"
        log "Phase 4: the $lane lane exited $code"
        continue
      fi
      age_min=$(( ($(date +%s) - started) / 60 ))
      if ! kill -0 "$pid" 2>/dev/null; then
        # The code is written BEFORE the wrapper exits, so gone-without-one
        # means it was killed. Sweep up anything it left holding the log.
        kill_support_lane "$pid" "$logp"
        printf -v "SR_${lane}_RESULT" '%s' "died"
        log "Phase 4: the $lane lane died without recording an exit code"
      elif [[ -f "$logp" && -n "$(find "$logp" -mmin "+$SUPPORT_LANE_STALE_MIN" 2>/dev/null)" ]]; then
        kill_support_lane "$pid" "$logp"
        printf -v "SR_${lane}_RESULT" '%s' "killed-stale"
        log "Phase 4: the $lane lane logged nothing for ${SUPPORT_LANE_STALE_MIN}+ min; killed"
      elif [[ "$age_min" -ge "$SUPPORT_LANE_MAX_MIN" ]]; then
        # A chatty hang (e.g. polling App Store Connect for ever) never goes
        # stale, so wall time caps it too.
        kill_support_lane "$pid" "$logp"
        printf -v "SR_${lane}_RESULT" '%s' "killed-cap"
        log "Phase 4: the $lane lane was still running after ${SUPPORT_LANE_MAX_MIN} min; killed"
      else
        still="$still $lane"
      fi
    done
    running="${still# }"
  done

  # The lanes are over: drop our claim on each root this run prepared (a no-op
  # for a root another live process has locked since).
  for lane in $prepared; do release_beta_build_root "$lane"; done

  for lane in mobile desktop; do
    v="SR_${lane}_RESULT"
    [[ -n "${!v}" ]] || continue
    lanes_arg="${lanes_arg:+$lanes_arg,}$lane=${!v}"
    v="SR_${lane}_LOG"
    logs_arg="${logs_arg:+$logs_arg,}$lane=${!v}"
  done
  if ! out=$(node "$SCRIPT_DIR/lib/support-release.mjs" settle --pending-file "$pending_file" \
      --lanes "$lanes_arg" --logs "$logs_arg" 2>>"$LOG_FILE"); then
    log "Phase 4: could not record the lane outcomes (see log); the next night re-checks"
    return 0
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && log "Phase 4: $line"
  done < <(echo "$out" | jq -r '.settled[]? |
    "#\(.number) \(.platform): " +
    (if .result == "ok" then "shipped (\"now live\" posted)"
     elif .result == "unknown" then "outcome unknown (\(.reason // "?")); re-checked next night"
     else "NOT shipped — attempt \(.failures) failed (\(.lane) lane: \(.laneResult))" +
          (if .reason then "; \(.reason)" else "" end) +
          (if .gaveUp then "; gave up — labelled needs-manual-intervention" else "; retry next night" end)
     end)' 2>/dev/null || true)
  return 0
}

log "=== Phase 4: Ship merged support fixes as beta builds ==="
ship_support_betas || log "WARNING: Phase 4 ended early (exit $?); the next night retries"

ELAPSED=$(( $(date +%s) - START_TIME ))
log "=== Nightly support run completed in ${ELAPSED}s ==="
